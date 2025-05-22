// CustomEdge.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useReactFlow, MarkerType } from 'reactflow';

const getInitialControlPoint = (sourceX, sourceY, targetX, targetY) => {
  return { 
    x: (sourceX + targetX) / 2, 
    y: (sourceY + targetY) / 2 
  };
};

export default function CustomEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
  style,
  selected,
}) {
  const rfInstance = useReactFlow();
  const { setEdges } = rfInstance;

  const [controlPoint, setControlPoint] = useState(() => {
    return data?.controlPoint || getInitialControlPoint(sourceX, sourceY, targetX, targetY);
  });

  useEffect(() => {
    if (!data?.controlPointDragged) {
      setControlPoint(getInitialControlPoint(sourceX, sourceY, targetX, targetY));
    }
  }, [sourceX, sourceY, targetX, targetY, data?.controlPointDragged]);

  useEffect(() => {
    if (data?.controlPoint) {
      if (data.controlPoint.x !== controlPoint.x || data.controlPoint.y !== controlPoint.y) {
        setControlPoint(data.controlPoint);
      }
    }
  }, [data?.controlPoint]);

  // --- [수정 시작] 곡선 경로 계산 ---
  let edgePath;

  // source와 target 사이의 전체 방향과 거리 계산
  const dirX_total = targetX - sourceX;
  const dirY_total = targetY - sourceY;
  const dist_total = Math.sqrt(dirX_total * dirX_total + dirY_total * dirY_total);

  if (dist_total === 0) {
    // Source와 Target이 같은 위치일 경우 (루프 생성)
    const spDx = controlPoint.x - sourceX;
    const spDy = controlPoint.y - sourceY;
    const sp_dist = Math.sqrt(spDx * spDx + spDy * spDy);

    if (sp_dist === 0) { // P도 S/T와 같은 위치
      edgePath = `M ${sourceX},${sourceY}`; // 점 하나만 그림
    } else {
      const nspDx = spDx / sp_dist;
      const nspDy = spDy / sp_dist;

      // C1을 P에서 S->P 방향에 수직으로 오프셋하여 루프의 "볼록함"을 만듦
      const perpDx = -nspDy;
      const perpDy = nspDx;
      const loopFactor = sp_dist * 0.5; // 루프의 크기 조절 계수

      const c1x = controlPoint.x + perpDx * loopFactor;
      const c1y = controlPoint.y + perpDy * loopFactor;
      
      // M S Q C1 P T S (여기서 T는 S와 같음)
      edgePath = `M ${sourceX},${sourceY} Q ${c1x},${c1y} ${controlPoint.x},${controlPoint.y} T ${targetX},${targetY}`;
    }
  } else {
    // Source와 Target이 다른 위치일 경우
    const unitDirX_total = dirX_total / dist_total; // S->T 단위 방향 벡터 X
    const unitDirY_total = dirY_total / dist_total; // S->T 단위 방향 벡터 Y

    // 곡선의 "팽팽함" 또는 "둥글기"를 조절하는 계수 (0.1 ~ 0.5 사이 값 권장)
    // 이 값을 조절하여 곡선의 모양을 변경할 수 있습니다.
    const CURVATURE_STRENGTH = 0.25; 
    const tensionOffset = dist_total * CURVATURE_STRENGTH;

    // 첫 번째 베지어 곡선(Source -> ControlPoint)의 컨트롤 핸들(c1) 계산
    // c1은 ControlPoint에서 (S->T 방향의 반대 방향)으로 tensionOffset만큼 떨어진 지점
    const c1x = controlPoint.x - unitDirX_total * tensionOffset;
    const c1y = controlPoint.y - unitDirY_total * tensionOffset;

    // 경로: M Source Q c1 ControlPoint T Target
    // M: Move to Source
    // Q c1 ControlPoint: Source에서 ControlPoint까지의 베지어 곡선 (c1이 핸들)
    // T Target: ControlPoint에서 Target까지 이전 곡선에 부드럽게 이어지는 베지어 곡선
    edgePath = `M ${sourceX},${sourceY} Q ${c1x},${c1y} ${controlPoint.x},${controlPoint.y} T ${targetX},${targetY}`;
  }
  // --- [수정 끝] ---

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);

  const onControlPointMouseDown = useCallback((event) => {
    event.stopPropagation();
    setDragStart({ screenX: event.clientX, screenY: event.clientY, cpInitialX: controlPoint.x, cpInitialY: controlPoint.y });
    setIsDragging(true);
  }, [controlPoint]);

  useEffect(() => {
    const handleMouseMove = (event) => {
      if (!isDragging || !dragStart || !rfInstance) return;
      event.preventDefault();
      event.stopPropagation();
      const { screenX: startScreenX, screenY: startScreenY, cpInitialX, cpInitialY } = dragStart;
      const { zoom } = rfInstance.getViewport();
      const deltaX = (event.clientX - startScreenX) / zoom;
      const deltaY = (event.clientY - startScreenY) / zoom;
      setControlPoint({ x: cpInitialX + deltaX, y: cpInitialY + deltaY });
    };
    const handleMouseUp = (event) => {
      if (!isDragging) return;
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);
      setDragStart(null);
      setEdges((eds) =>
        eds.map((edge) => {
          if (edge.id === id) {
            return { ...edge, data: { ...edge.data, controlPoint: controlPoint, controlPointDragged: true } };
          }
          return edge;
        })
      );
    };
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragStart, setEdges, id, controlPoint, rfInstance]);

  const baseStyleFromProps = style || {};
  const visiblePathStyle = { ...baseStyleFromProps };
  const finalMarkerEnd = markerEnd ? {
      ...markerEnd,
      color: selected ? '#007bff' : (markerEnd.color || baseStyleFromProps?.stroke || '#555'),
  } : undefined;
  const interactionPathStyle = {
    stroke: 'transparent',
    strokeWidth: Math.max(Number(baseStyleFromProps.strokeWidth) || 1.5, 10) + 5,
    fill: 'none',
    pointerEvents: 'stroke',
  };
  const controlPointInteractionRadius = 10;

  return (
    <>
      <path
        className="react-flow__edge-interaction"
        d={edgePath}
        style={interactionPathStyle}
      />
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        style={visiblePathStyle}
        markerEnd={finalMarkerEnd}
      />
      {selected && (
        <>
          <circle
            cx={controlPoint.x}
            cy={controlPoint.y}
            r={6}
            fill="#fff"
            stroke="#007bff"
            strokeWidth={1.5}
            style={{ cursor: 'move' }}
            onMouseDown={onControlPointMouseDown}
            className="react-flow__edge-control-point"
          />
          <circle
            cx={controlPoint.x}
            cy={controlPoint.y}
            r={controlPointInteractionRadius}
            fill="transparent"
            style={{ cursor: 'move' }}
            onMouseDown={onControlPointMouseDown}
          />
        </>
      )}
    </>
  );
}