import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { Stage, Layer, Circle, Line, Text, Group } from 'react-konva';
import * as d3 from 'd3';
import { MindMapData, MindMapNode, MindMapEdge } from '../types';

interface MindMapProps {
  data: MindMapData;
  onNodeClick?: (node: MindMapNode) => void;
}

export interface MindMapRef {
  exportImage: () => string | undefined;
}

export const MindMap = forwardRef<MindMapRef, MindMapProps>(({ data, onNodeClick }, ref) => {
  const [nodes, setNodes] = useState<MindMapNode[]>([]);
  const [edges, setEdges] = useState<MindMapEdge[]>([]);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<any>(null);

  const autoFit = (currentNodes: MindMapNode[]) => {
    if (currentNodes.length === 0 || dimensions.width === 0) return;

    // Calculate bounding box of all nodes
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    currentNodes.forEach(node => {
      const radius = node.type === 'root' ? 50 : node.type === 'main' ? 40 : 30;
      minX = Math.min(minX, node.x - radius);
      minY = Math.min(minY, node.y - radius);
      maxX = Math.max(maxX, node.x + radius);
      maxY = Math.max(maxY, node.y + radius);
    });

    const mapWidth = maxX - minX;
    const mapHeight = maxY - minY;
    const padding = 40;

    // Calculate scale to fit
    const scaleX = (dimensions.width - padding * 2) / mapWidth;
    const scaleY = (dimensions.height - padding * 2) / mapHeight;
    const newScale = Math.min(scaleX, scaleY, 1); // Don't zoom in more than 1:1

    // Calculate position to center
    const newX = (dimensions.width / 2) - (newScale * (minX + maxX) / 2);
    const newY = (dimensions.height / 2) - (newScale * (minY + maxY) / 2);

    setStageScale(newScale);
    setStagePos({ x: newX, y: newY });
  };

  useImperativeHandle(ref, () => ({
    exportImage: () => {
      if (stageRef.current) {
        // Use a white background for the export
        return stageRef.current.toDataURL({ 
          pixelRatio: 3,
          mimeType: 'image/png'
        });
      }
      return undefined;
    }
  }));

  // Initialize expanded nodes with root when data changes
  useEffect(() => {
    const rootNode = data.nodes.find(n => n.type === 'root');
    if (rootNode) {
      setExpandedNodeIds(new Set([rootNode.id]));
    } else if (data.nodes.length > 0) {
      setExpandedNodeIds(new Set([data.nodes[0].id]));
    }
  }, [data]);

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!data.nodes.length || dimensions.width === 0) return;

    // Determine visible nodes based on expansion state
    const visibleNodeIds = new Set<string>();
    const rootNode = data.nodes.find(n => n.type === 'root') || data.nodes[0];
    if (rootNode) visibleNodeIds.add(rootNode.id);

    // Iteratively find visible children
    let changed = true;
    while (changed) {
      changed = false;
      data.edges.forEach(edge => {
        if (visibleNodeIds.has(edge.source) && expandedNodeIds.has(edge.source) && !visibleNodeIds.has(edge.target)) {
          visibleNodeIds.add(edge.target);
          changed = true;
        }
      });
    }

    const filteredNodes = data.nodes.filter(n => visibleNodeIds.has(n.id));
    const filteredEdges = data.edges.filter(e => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));

    // Create a deep copy of filtered data
    const nodesCopy = filteredNodes.map(n => ({ ...n }));
    const edgesCopy = filteredEdges.map(e => ({ ...e }));

    // Run D3 force simulation to position nodes
    const simulation = d3.forceSimulation(nodesCopy as any)
      .force("link", d3.forceLink(edgesCopy as any).id((d: any) => d.id).distance(150))
      .force("charge", d3.forceManyBody().strength(-1500))
      .force("center", d3.forceCenter(dimensions.width / 2, dimensions.height / 2))
      .force("collision", d3.forceCollide().radius(100))
      .stop();

    // Run simulation synchronously for a stable layout
    for (let i = 0; i < 120; ++i) simulation.tick();

    const finalNodes = [...nodesCopy];
    setNodes(finalNodes);
    setEdges([...edgesCopy]);
    
    // Auto-fit the map to the screen
    autoFit(finalNodes);

    return () => {
      simulation.stop();
    };
  }, [data, dimensions.width, dimensions.height, expandedNodeIds]);

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    const scaleBy = 1.05;
    const stage = e.target.getStage();
    const oldScale = stage.scaleX();

    const mousePointTo = {
      x: stage.getPointerPosition().x / oldScale - stage.x() / oldScale,
      y: stage.getPointerPosition().y / oldScale - stage.y() / oldScale,
    };

    const newScale = e.evt.deltaY < 0 ? oldScale * scaleBy : oldScale / scaleBy;

    setStageScale(newScale);
    setStagePos({
      x: -(mousePointTo.x - stage.getPointerPosition().x / newScale) * newScale,
      y: -(mousePointTo.y - stage.getPointerPosition().y / newScale) * newScale,
    });
  };

  const handleNodeClick = (node: MindMapNode) => {
    // Toggle expansion
    setExpandedNodeIds(prev => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        // If collapsing, we might want to collapse all descendants too
        // For now, just simple toggle
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
    
    // Call external click handler
    onNodeClick?.(node);
  };

  return (
    <div ref={containerRef} className="w-full h-full bg-slate-50 overflow-hidden rounded-xl border border-slate-200 relative">
      <Stage 
        ref={stageRef}
        width={dimensions.width} 
        height={dimensions.height} 
        draggable
        onWheel={handleWheel}
        scaleX={stageScale}
        scaleY={stageScale}
        x={stagePos.x}
        y={stagePos.y}
        onDragMove={(e) => {
          setStagePos({ x: e.target.x(), y: e.target.y() });
        }}
        onDragEnd={(e) => {
          setStagePos({ x: e.target.x(), y: e.target.y() });
        }}
      >
        <Layer>
          {/* Background for export */}
          <Circle 
            x={0} 
            y={0} 
            radius={5000} 
            fill="#f8fafc" 
            listening={false}
          />
          
          {/* Edges */}
          {edges.map((edge) => {
            const sourceNode = nodes.find(n => n.id === edge.source);
            const targetNode = nodes.find(n => n.id === edge.target);
            if (!sourceNode || !targetNode) return null;

            return (
              <Line
                key={edge.id}
                points={[sourceNode.x, sourceNode.y, targetNode.x, targetNode.y]}
                stroke="#cbd5e1"
                strokeWidth={2}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const hasChildren = data.edges.some(e => e.source === node.id);
            const isExpanded = expandedNodeIds.has(node.id);

            return (
              <Group
                key={node.id}
                x={node.x}
                y={node.y}
                onClick={() => handleNodeClick(node)}
                onTap={() => handleNodeClick(node)}
                style={{ cursor: 'pointer' }}
              >
                <Circle
                  radius={node.type === 'root' ? 50 : node.type === 'main' ? 40 : 30}
                  fill={node.color || '#94a3b8'}
                  stroke={isExpanded ? 'white' : 'transparent'}
                  strokeWidth={3}
                  shadowBlur={10}
                  shadowOpacity={0.1}
                />
                
                {/* Expansion Indicator */}
                {hasChildren && (
                  <Circle
                    radius={8}
                    x={node.type === 'root' ? 45 : node.type === 'main' ? 35 : 25}
                    y={node.type === 'root' ? -45 : node.type === 'main' ? -35 : -25}
                    fill={isExpanded ? '#ef4444' : '#22c55e'}
                    stroke="white"
                    strokeWidth={1}
                  />
                )}

                <Text
                  text={node.label}
                  fontSize={node.type === 'root' ? 16 : node.type === 'main' ? 14 : 12}
                  fontStyle="bold"
                  fill="white"
                  align="center"
                  verticalAlign="middle"
                  width={node.type === 'root' ? 90 : node.type === 'main' ? 70 : 50}
                  height={node.type === 'root' ? 90 : node.type === 'main' ? 70 : 50}
                  offsetX={node.type === 'root' ? 45 : node.type === 'main' ? 35 : 25}
                  offsetY={node.type === 'root' ? 45 : node.type === 'main' ? 35 : 25}
                  listening={false}
                  shadowColor="rgba(0,0,0,0.5)"
                  shadowBlur={2}
                  shadowOffset={{ x: 1, y: 1 }}
                />
              </Group>
            );
          })}
        </Layer>
      </Stage>
      <div className="absolute bottom-4 left-4 bg-white/80 backdrop-blur-sm border border-slate-200 rounded-lg p-3 shadow-sm pointer-events-none">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-3 h-3 rounded-full bg-green-500 border border-white" />
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Expandable</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500 border border-white" />
          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Collapsible</span>
        </div>
        <p className="text-[10px] text-slate-400 mt-2 italic">Click nodes to reveal sub-topics</p>
      </div>
    </div>
  );
});
