export interface MindMapNode {
  id: string;
  label: string;
  description?: string;
  x: number;
  y: number;
  color?: string;
  type: 'root' | 'main' | 'sub';
}

export interface MindMapEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface MindMapData {
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}
