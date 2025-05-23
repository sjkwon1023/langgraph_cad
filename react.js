import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  MiniMap,
  Controls,
  Background,
  Panel,
  useNodesState,
  useEdgesState,
  MarkerType, // MarkerType 임포트 확인
  Handle,
  Position,
  useKeyPress,
  useReactFlow,
  getBezierPath, 
  BaseEdge,    
  EdgeProps,   
  useStore     
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { tomorrow } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ReactDOM from 'react-dom/client';

import CustomEdge from './CustomEdge'; 

// Helper: 코드 식별자를 안전하게 만들고 유일성을 보장
const sanitizeIdentifier = (baseName, existingNodes, currentNodeIdToExclude = null) => {
  // START와 END 노드는 특별 처리
  if (baseName === 'START' || baseName === 'END') {
    return baseName.toLowerCase();
  }

  let identifier = baseName.trim().replace(/\s+/g, '_');
  identifier = identifier.replace(/[^a-zA-Z0-9_]/g, '');

  if (!identifier) {
    const fallbackName = baseName.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
    identifier = fallbackName || `node`;
  }

  let finalIdentifier = identifier;
  let counter = 1;
  while (
    existingNodes.some(
      (n) =>
        (currentNodeIdToExclude ? n.id !== currentNodeIdToExclude : true) &&
        n.data.codeIdentifier === finalIdentifier
    )
  ) {
    finalIdentifier = `${identifier}_${counter}`;
    counter++;
  }
  return finalIdentifier;
};

// Helper to format graph code
function formatGraphCode(nodes, edges, entryPointCodeId, graphName) {
  const lines = [
    'from langgraph import StateGraph, AgentState',
    '',
    `${graphName} = StateGraph(AgentState)`
  ];

  // Add only non-conditional_edge, non-start, non-end, non-text nodes
  nodes
    .filter(node => 
      node.data.type !== 'conditional_edge' && 
      node.data.type !== 'start' && 
      node.data.type !== 'end' &&
      node.data.type !== 'text'
    )
    .forEach((node) => {
      const nodeNameInCode = node.data.codeIdentifier || node.id;
      const nodeImplementation = node.data.obj || node.data.type || `'${nodeNameInCode}_func'`;
      lines.push(
        `${graphName}.add_node("${nodeNameInCode}", ${nodeImplementation})`
      );
    });

  // Find the node connected to START node
  const startNode = nodes.find(node => node.data.type === 'start');
  if (startNode) {
    const startEdge = edges.find(edge => edge.source === startNode.id);
    if (startEdge) {
      const targetNode = nodes.find(node => node.id === startEdge.target);
      if (targetNode) {
        const targetNodeName = targetNode.data.codeIdentifier || targetNode.id;
        lines.push(`${graphName}.set_entry_point("${targetNodeName}")`);
      }
    }
  }

  // Handle edges, excluding edges connected to text nodes and start node
  const edgesToProcess = edges.filter(edge => {
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    return sourceNode?.data.type !== 'text' && 
           targetNode?.data.type !== 'text' &&
           sourceNode?.data.type !== 'start';
  });

  // Separate conditional edges
  const conditionalEdges = edgesToProcess.filter(edge => {
    const sourceNode = nodes.find(n => n.id === edge.source);
    return sourceNode && sourceNode.data.type === 'conditional_edge';
  });

  // Group conditional edges by their conditional edge node
  const conditionalEdgeGroups = conditionalEdges.reduce((groups, edge) => {
    const conditionalNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    
    // Find the actual source node (the node connected to the conditional edge node)
    const actualSourceEdge = edges.find(e => e.target === edge.source);
    const actualSourceNode = actualSourceEdge ? nodes.find(n => n.id === actualSourceEdge.source) : null;
    
    if (actualSourceNode && targetNode && conditionalNode) {
      const sourceName = actualSourceNode.data.codeIdentifier || actualSourceNode.id;
      const targetName = targetNode.data.codeIdentifier || targetNode.id;
      
      // Use conditional node ID as the key for grouping
      if (!groups[conditionalNode.id]) {
        groups[conditionalNode.id] = {
          sourceNode: sourceName,
          targets: {}
        };
      }
      groups[conditionalNode.id].targets[targetName] = targetName;
    }
    return groups;
  }, {});

  // Add conditional edges
  Object.entries(conditionalEdgeGroups).forEach(([conditionalNodeId, { sourceNode, targets }], index) => {
    const funcName = `conditional_function_${index + 1}`;
    
    lines.push(
      '',
      `${graphName}.add_conditional_edges(`,
      `    "${sourceNode}",`,
      `    ${funcName},`,
      `    {`,
      ...Object.entries(targets).map(([key, value]) => 
        `        "${key}": "${value}"`
      ),
      `    }`,
      `)`
    );
  });

  // Add regular edges (excluding conditional edges)
  const regularEdges = edgesToProcess.filter(edge => {
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    return sourceNode && targetNode && 
           sourceNode.data.type !== 'conditional_edge' && 
           targetNode.data.type !== 'conditional_edge';
  });

  regularEdges.forEach((edge) => {
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    if (sourceNode && targetNode) {
      const sourceName = sourceNode.data.codeIdentifier || sourceNode.id;
      const targetName = targetNode.data.codeIdentifier || targetNode.id;
      lines.push(`${graphName}.add_edge("${sourceName}", "${targetName}")`);
    }
  });

  return lines.join('\n');
}

const nodeTypesDefinition = {
  start: { type: 'start', label: 'START', obj: 'start_function' },
  end: { type: 'end', label: 'END', obj: 'end_function' },
  agent: { type: 'agent', label: 'Agent', obj: 'agent_function' },
  tool: { type: 'tool', label: 'Tool', obj: 'tool_function' },
  conditional_edge: { type: 'conditional_edge', label: 'Conditional Edge', obj: 'condition_function' },
  text: { type: 'text', label: 'Text', obj: null }
};

// --- CustomNode 수정 ---
const CustomNode = ({ data, id, selected, isEditing, onEditClick, onLabelUpdate, onEditCancel }) => {
  const [currentLabel, setCurrentLabel] = useState(data.label || '');
  const inputRef = useRef(null);

  useEffect(() => {
    setCurrentLabel(data.label || '');
  }, [data.label]);

  const handleBlur = useCallback(() => {
    onLabelUpdate(id, currentLabel);
  }, [onLabelUpdate, currentLabel, id]);

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onLabelUpdate(id, currentLabel);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setCurrentLabel(data.label || '');
      onEditCancel();
    }
  }, [onLabelUpdate, onEditCancel, currentLabel, data.label, id]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // 노드 타입에 따른 스타일 설정
  const getNodeStyle = () => {
    const baseStyle = {
      padding: '10px 15px',
      borderRadius: '8px',
      position: 'relative',
      minWidth: '180px',
      cursor: 'default',
      border: '1px solid #ccc',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      transition: 'all 0.2s ease-in-out'
    };

    switch (data.type) {
      case 'start':
        return {
          ...baseStyle,
          backgroundColor: '#e8f5e9',
          borderColor: '#4caf50',
          color: '#2e7d32'
        };
      case 'end':
        return {
          ...baseStyle,
          backgroundColor: '#ffebee',
          borderColor: '#f44336',
          color: '#c62828'
        };
      case 'text':
        return {
          ...baseStyle,
          backgroundColor: '#fff3e0',
          borderColor: '#ff9800',
          color: '#e65100',
          fontStyle: 'italic',
          minWidth: '200px',
          maxWidth: '300px'
        };
      default:
        return {
          ...baseStyle,
          backgroundColor: '#fff'
        };
    }
  };

  // 노드 타입에 따른 핸들 표시 여부 설정
  const showSourceHandle = data.type !== 'end';
  const showTargetHandle = data.type !== 'start';

  return (
    <div
      className="custom-node-wrapper"
      style={getNodeStyle()}
      title={`ID: ${id}\nCode Name: ${data.codeIdentifier || 'N/A'}`}
    >
      {selected && !isEditing && data.type !== 'start' && data.type !== 'end' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEditClick();
          }}
          style={{
            position: 'absolute', top: '-10px', right: '-10px', width: '24px', height: '24px',
            borderRadius: '50%', border: '1px solid #ddd', backgroundColor: '#fff',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', padding: 0, boxShadow: '0 2px 5px rgba(0,0,0,0.15)', zIndex: 10,
          }}
          title="Edit node name"
        >
          ✎
        </button>
      )}
      {showTargetHandle && <Handle type="target" position={Position.Top} style={{ background: '#555' }} />}
      {isEditing ? (
        <input
          ref={inputRef}
          value={currentLabel}
          onChange={(e) => setCurrentLabel(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%', border: '1px dashed #aaa', outline: 'none',
            backgroundColor: 'transparent', fontSize: '14px', fontWeight: '500',
            color: 'inherit', padding: '2px', margin: '0', boxSizing: 'border-box',
          }}
        />
      ) : (
        <div style={{ 
          fontSize: '14px', 
          fontWeight: '500', 
          color: 'inherit', 
          userSelect: 'none',
          textAlign: 'center'
        }}>
          {data.label || '(이름 없음)'}
        </div>
      )}
      {showSourceHandle && <Handle type="source" position={Position.Bottom} style={{ background: '#555' }} />}
      {data.type && data.type !== 'start' && data.type !== 'end' && data.type !== 'text' && (
        <div style={{ 
          fontSize: '10px', 
          color: '#777', 
          marginTop: '5px', 
          textAlign: 'center', 
          textTransform: 'uppercase' 
        }}>
          {data.type}
        </div>
      )}
    </div>
  );
};

function GraphEditorCore() {
  const [nodes, setNodes, onNodesChange] = useNodesState(() => {
    try {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const state = JSON.parse(decodeURIComponent(hash));
        return state.nodes || [];
      }
    } catch (e) {
      console.error('Failed to parse state from URL:', e);
    }
    // 초기 상태에 START 노드 추가
    return [{
      id: 'start-1',
      type: 'custom',
      position: { x: 100, y: 100 },
      data: { 
        type: 'start', 
        label: 'START', 
        codeIdentifier: 'start'
      },
      zIndex: 10
    }];
  });
  const [edges, setEdges, onEdgesChange] = useEdgesState(() => {
    try {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const state = JSON.parse(decodeURIComponent(hash));
        return state.edges || [];
      }
    } catch (e) {
      console.error('Failed to parse state from URL:', e);
    }
    return [];
  });
  const [entryPointCodeId, setEntryPointCodeId] = useState(() => {
    try {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const state = JSON.parse(decodeURIComponent(hash));
        return state.entryPointCodeId || null;
      }
    } catch (e) {
      console.error('Failed to parse state from URL:', e);
    }
    return null;
  });
  const [editingNodeId, setEditingNodeId] = useState(null);
  const [code, setCode] = useState('');
  const [graphName, setGraphName] = useState(() => {
    try {
      const hash = window.location.hash.slice(1);
      if (hash) {
        const state = JSON.parse(decodeURIComponent(hash));
        return state.graphName || 'my_graph';
      }
    } catch (e) {
      console.error('Failed to parse state from URL:', e);
    }
    return 'my_graph';
  });
  const [selectedElements, setSelectedElements] = useState([]);
  
  const reactFlowInstance = useReactFlow();
  const deleteKeyPressed = useKeyPress(['Backspace', 'Delete']);

  const edgeTypes = React.useMemo(() => ({
    customEdge: CustomEdge,
  }), []);

  useEffect(() => {
    const styleId = 'custom-node-styles-for-selection';
    let styleElement = document.getElementById(styleId);

    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = styleId;
      document.head.appendChild(styleElement);
    }

    styleElement.textContent = `
      .custom-node-wrapper {
        border: 1px solid #ccc;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        transition: all 0.2s ease-in-out;
      }
      .react-flow__node.selected .custom-node-wrapper {
        border: 2px solid #007bff !important;
        box-shadow: 0 0 0 2px rgba(0, 123, 255, 0.2), 0 6px 15px rgba(0,0,0,0.1) !important;
      }
      .react-flow__edge.selected .react-flow__edge-path {
        stroke: #007bff !important;
        stroke-width: 2.5px !important;
      }
      .react-flow__edge.selected marker path {
        fill: #007bff !important;
      }
    `;
  }, []); 

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const typeKey = event.dataTransfer.getData('application/reactflow');
      if (!typeKey || !reactFlowInstance) return;

      const typeInfo = nodeTypesDefinition[typeKey];
      if (!typeInfo) return;

      // START와 END 노드는 이미 존재하는지 확인
      if (typeKey === 'start' || typeKey === 'end') {
        const existingNode = nodes.find(n => n.data.type === typeKey);
        if (existingNode) {
          alert(`${typeInfo.label} node already exists.`);
          return;
        }
      }

      const position = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const newNodeId = `${typeKey}-${Date.now()}`;
      
      setNodes((currentNodes) => {
        const initialLabel = typeInfo.label;
        const initialCodeIdentifier = sanitizeIdentifier(initialLabel, currentNodes, null);
        const newNode = {
          id: newNodeId,
          type: 'custom',
          position,
          data: { ...typeInfo, label: initialLabel, codeIdentifier: initialCodeIdentifier },
          zIndex: 10,
        };
        return currentNodes.concat(newNode);
      });
    },
    [reactFlowInstance, setNodes, nodes]
  );

  const onConnect = useCallback( // 엣지 생성 시 zIndex 추가
    (connection) => {
      if (connection.source === connection.target) return;
      
      // Find the source node to check its type
      const sourceNode = nodes.find(n => n.id === connection.source);
      const isConditionalEdge = sourceNode?.data?.type === 'conditional_edge';
      
      const newEdge = {
        ...connection,
        type: 'customEdge', 
        markerEnd: { type: MarkerType.ArrowClosed, color: '#555', width: 15, height: 15 },
        style: { 
          stroke: '#555', 
          strokeWidth: 1.5,
          strokeDasharray: isConditionalEdge ? '5,5' : 'none' // Add dashed line for conditional edges
        },
        data: {},
        zIndex: 5, // 엣지 기본 zIndex
      };
      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges, nodes] // Add nodes to dependencies since we're using it in the callback
  );

  // [새로운 로직] Shift 클릭에 따른 선택/해제 처리
  const onNodeClick = useCallback((event, clickedNode) => {
    event.preventDefault(); // 기본 선택 동작 방지
    if (event.shiftKey) {
      // Shift + 클릭: 토글 선택
      onNodesChange([{ 
        type: 'select', 
        id: clickedNode.id, 
        selected: !clickedNode.selected 
      }]);
    } else {
      // 일반 클릭: 다른 모든 노드 선택 해제하고 현재 노드만 선택
      const nodeChanges = nodes.map(n => ({
        id: n.id,
        type: 'select',
        selected: n.id === clickedNode.id
      }));
      const edgeChanges = edges.map(e => ({
        id: e.id,
        type: 'select',
        selected: false 
      }));
      onNodesChange(nodeChanges);
      onEdgesChange(edgeChanges);
    }
  }, [nodes, edges, onNodesChange, onEdgesChange]);

  const onEdgeClick = useCallback((event, clickedEdge) => {
    event.preventDefault(); // 기본 선택 동작 방지
    if (event.shiftKey) {
      // Shift + 클릭: 토글 선택
      onEdgesChange([{ 
        type: 'select', 
        id: clickedEdge.id, 
        selected: !clickedEdge.selected 
      }]);
    } else {
      // 일반 클릭: 다른 모든 엣지 선택 해제하고 현재 엣지만 선택
      const edgeChanges = edges.map(e => ({
        id: e.id,
        type: 'select',
        selected: e.id === clickedEdge.id
      }));
      const nodeChanges = nodes.map(n => ({
        id: n.id,
        type: 'select',
        selected: false 
      }));
      onEdgesChange(edgeChanges);
      onNodesChange(nodeChanges);
    }
  }, [nodes, edges, onNodesChange, onEdgesChange]);
  
  const onSelectionChange = useCallback( // zIndex 및 selectedElements 업데이트 로직 유지
    ({ nodes: selectedNodesFromEvent, edges: selectedEdgesFromEvent }) => {
      setSelectedElements([...selectedNodesFromEvent, ...selectedEdgesFromEvent]);

      setNodes((prevNodes) =>
        prevNodes.map((node) => {
          const isSelected = selectedNodesFromEvent.some((sn) => sn.id === node.id);
          return {
            ...node,
            zIndex: isSelected ? 20 : (node.zIndex === 20 ? 10 : node.zIndex || 10), // 기본값 보장
          };
        })
      );

      setEdges((prevEdges) =>
        prevEdges.map((edge) => {
          const isSelected = selectedEdgesFromEvent.some((se) => se.id === edge.id);
          return {
            ...edge,
            zIndex: isSelected ? 100 : (edge.zIndex === 100 ? 5 : edge.zIndex || 5), // 기본값 보장
          };
        })
      );
    },
    [setNodes, setEdges]
  );
  
  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onEditButtonClick = useCallback(
    (nodeId) => {
      setEditingNodeId(nodeId);
      setNodes((prevNodes) =>
        prevNodes.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data } } : node
        )
      );
    },
    [setNodes]
  );

  const onNodeLabelUpdate = useCallback(
    (nodeIdToUpdate, newDisplayLabel) => {
      const trimmedLabel = newDisplayLabel.trim();

      if (!trimmedLabel) {
        alert('Node name (Label) cannot be empty.');
        if (editingNodeId === nodeIdToUpdate) {
            setEditingNodeId(null);
            setNodes(nds => nds.map(n => n.id === nodeIdToUpdate ? { ...n, data: { ...n.data }} : n));
        }
        return;
      }

      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          if (node.id === nodeIdToUpdate) {
            const newCodeIdentifier = sanitizeIdentifier(trimmedLabel, currentNodes, nodeIdToUpdate);
            return {
              ...node,
              data: { ...node.data, label: trimmedLabel, codeIdentifier: newCodeIdentifier },
            };
          }
          return node;
        })
      );
      setEditingNodeId(null);
    },
    [setNodes, editingNodeId] // sanitizeIdentifier가 currentNodes를 사용하므로 의존성에 currentNodes 추가 고려 (또는 함수를 useCallback 내부로)
  );
  
  const onNodeEditCancel = useCallback(() => {
    const currentlyEditing = editingNodeId;
    setEditingNodeId(null);
    if (currentlyEditing) {
      setNodes((prevNodes) =>
        prevNodes.map((node) =>
          node.id === currentlyEditing ? { ...node, data: { ...node.data } } : node
        )
      );
    }
  }, [setNodes, editingNodeId]);

  useEffect(() => {
    setCode(formatGraphCode(nodes, edges, entryPointCodeId, graphName));
  }, [nodes, edges, entryPointCodeId, graphName]);

  const copyToClipboard = async () => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = code;
      document.body.appendChild(textArea); textArea.select(); document.execCommand('copy');
      document.body.removeChild(textArea);
      alert('Code has been copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy code:', err);
      alert('Failed to copy code.');
    }
  };

  useEffect(() => {
    if (deleteKeyPressed && selectedElements.length > 0) {
      const nodeIdsToDelete = selectedElements.filter(el => el.type !== undefined && el.position !== undefined).map(el => el.id);
      const edgeIdsToDelete = selectedElements.filter(el => el.source !== undefined && el.target !== undefined).map(el => el.id);
      
      let newEntryPointCodeId = entryPointCodeId;
      const entryNode = nodes.find(n => n.data.codeIdentifier === entryPointCodeId);
      if(entryNode && nodeIdsToDelete.includes(entryNode.id)) {
        newEntryPointCodeId = null;
      }

      setNodes((nds) => nds.filter((node) => !nodeIdsToDelete.includes(node.id)));
      setEdges((eds) => eds.filter((edge) => !edgeIdsToDelete.includes(edge.id)));
      
      if (newEntryPointCodeId !== entryPointCodeId) {
        setEntryPointCodeId(newEntryPointCodeId);
      }
      setSelectedElements([]);
    }
  }, [deleteKeyPressed, selectedElements, nodes, edges, entryPointCodeId, setNodes, setEdges, setEntryPointCodeId]);

  // Save state to URL hash whenever it changes
  useEffect(() => {
    const state = {
      nodes,
      edges,
      entryPointCodeId,
      graphName
    };
    const hash = encodeURIComponent(JSON.stringify(state));
    window.history.replaceState(null, '', `#${hash}`);
  }, [nodes, edges, entryPointCodeId, graphName]);

  // Add a reset function to clear saved state
  const resetGraph = useCallback(() => {
    window.history.replaceState(null, '', window.location.pathname);
    setNodes([]);
    setEdges([]);
    setEntryPointCodeId(null);
    setGraphName('my_graph');
  }, [setNodes, setEdges]);

  const memoizedNodeTypes = React.useMemo(() => {
    return {
      custom: (props) => (
        <CustomNode
          {...props}
          onEditClick={() => onEditButtonClick(props.id)}
          onLabelUpdate={onNodeLabelUpdate}
          onEditCancel={onNodeEditCancel}
          isEditing={editingNodeId === props.id}
        />
      )
    };
  }, [editingNodeId, onEditButtonClick, onNodeLabelUpdate, onNodeEditCancel]);

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif" }}>
      <div style={{ width: '220px', padding: '15px', borderRight: '1px solid #e0e0e0', background: '#f9f9f9', overflowY: 'auto', position: 'relative' }}>
        {/* Sidebar content */}
        <h3 style={{ marginTop: 0, marginBottom: '15px', color: '#333', fontSize: '18px' }}>Add Node</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {Object.entries(nodeTypesDefinition).map(([key, nodeType]) => (
            <div
              key={key} draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/reactflow', key);
                event.dataTransfer.effectAllowed = 'move';
              }}
              style={{
                padding: '12px 15px', border: '1px solid #ddd', borderRadius: '6px',
                background: '#fff', cursor: 'grab', textAlign: 'center',
                fontSize: '14px', fontWeight: '500', color: '#444',
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)', transition: 'box-shadow 0.2s ease',
              }}
              onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 3px 6px rgba(0,0,0,0.1)'}
              onMouseLeave={(e) => e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.05)'}
            >
              {nodeType.label}
            </div>
          ))}
        </div>
        <hr style={{margin: '25px 0', border: '0', borderTop: '1px solid #eee'}}/>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            onClick={resetGraph}
            style={{
              padding: '10px 15px',
              borderRadius: '6px',
              border: '1px solid #dc3545',
              background: '#fff',
              color: '#dc3545',
              cursor: 'pointer',
              fontSize: '14px',
              width: '100%',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#dc3545';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.color = '#dc3545';
            }}
          >
            Reset All
          </button>
          <button
            onClick={() => {
              const url = window.location.href;
              navigator.clipboard.writeText(url).then(() => {
                alert('Current graph URL has been copied to clipboard!');
              }).catch(err => {
                console.error('Failed to copy URL:', err);
                alert('Failed to copy URL.');
              });
            }}
            style={{
              padding: '10px 15px',
              borderRadius: '6px',
              border: '1px solid #28a745',
              background: '#fff',
              color: '#28a745',
              cursor: 'pointer',
              fontSize: '14px',
              width: '100%',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#28a745';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.color = '#28a745';
            }}
          >
            Copy URL
          </button>
          <button
            onClick={() => {
              window.open('https://github.com/sjkwon1023/langgraph_cad/tree/main', '_blank');
            }}
            style={{
              padding: '10px 15px',
              borderRadius: '6px',
              border: '1px solid #6c757d',
              background: '#fff',
              color: '#6c757d',
              cursor: 'pointer',
              fontSize: '14px',
              width: '100%',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#6c757d';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#fff';
              e.currentTarget.style.color = '#6c757d';
            }}
          >
            Readme
          </button>
        </div>
        <div style={{
          position: 'absolute',
          bottom: '10px',
          left: '15px',
          fontSize: '12px',
          color: '#ccc',
          fontStyle: 'italic',
          opacity: 0.5,
          pointerEvents: 'none',
          lineHeight: '1.4'
        }}>
          Sejin Kwon<br />
          sjkwon1023@gmail.com
        </div>
      </div>
      
      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          multiSelectionKeyCode={['Shift']} // Shift 키를 다중 선택 키로 설정
          onSelectionChange={onSelectionChange}
          nodeTypes={memoizedNodeTypes}
          edgeTypes={edgeTypes} 
          deleteKeyCode={null} 
          attributionPosition="bottom-left"
          defaultEdgeOptions={{ 
            style: { stroke: '#555', strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#555', width: 15, height: 15 }
          }}
          panOnDrag={[2]}
          selectionOnDrag={true}
          selectionMode="partial"
          panOnScroll={false}
          zoomOnScroll={true}
          preventScrolling={true}
          nodesDraggable={true}
          nodesConnectable={true}
          elementsSelectable={true}
          selectNodesOnDrag={false} // 드래그로 노드 선택 비활성화
        >
          <MiniMap nodeStrokeWidth={3} zoomable pannable />
          <Controls />
          <Background color="#e9e9e9" gap={20} size={1.5} />
          <Panel position="top-right">
            <button onClick={copyToClipboard} style={{
              padding: '10px 15px', borderRadius: '6px', border: 'none',
              background: '#007bff', color: 'white', cursor: 'pointer',
              fontSize: '14px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
            }}>Copy Code</button>
          </Panel>
        </ReactFlow>
      </div>

      <div style={{ width: '40%', minWidth: '350px', padding: '15px', borderLeft: '1px solid #e0e0e0', background: '#fdfdfd', display: 'flex', flexDirection: 'column', overflowY: 'hidden' }}>
        {/* Code panel content */}
        <div style={{ marginBottom: '15px' }}>
          <h3 style={{ margin: '0 0 10px 0', color: '#333', fontSize: '18px' }}>Generated Code</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', background: '#f0f0f0', borderRadius: '6px', border: '1px solid #e0e0e0' }}>
            <label htmlFor="graphNameInput" style={{ fontSize: '14px', fontWeight: '500', color: '#333' }}>Graph Name:</label>
            <input
              id="graphNameInput" type="text" value={graphName}
              onChange={(e) => setGraphName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
              style={{ padding: '10px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '14px', width: '100%', boxSizing: 'border-box' }}
              placeholder="예: my_workflow_graph"
            />
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', background: '#2d2d2d', borderRadius: '6px', border: '1px solid #444' }}>
          <SyntaxHighlighter language="python" style={tomorrow} wrapLongLines customStyle={{ margin: 0, padding: '15px', fontSize: '13px', height: '100%' }}>
            {code}
          </SyntaxHighlighter>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <GraphEditorCore />
    </ReactFlowProvider>
  );
}

let root = null;
const container = document.getElementById('root');
if (container && !root) {
  root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}