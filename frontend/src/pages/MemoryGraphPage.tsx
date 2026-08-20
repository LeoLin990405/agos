import React, { useState, useMemo } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { CanvasGraph } from '@/components/graph/CanvasGraph';
import { GraphInspector } from '@/components/graph/GraphInspector';
import { GraphControls } from '@/components/graph/GraphControls';
import { generateMockMemoryGraph, MemoryNodeData } from '@/components/graph/mock-graph-data';

export const MemoryGraphPage: React.FC = () => {
  const graphData = useMemo(() => generateMockMemoryGraph(), []);
  const [selectedNode, setSelectedNode] = useState<MemoryNodeData | null>(null);
  const [hoveredNode, setHoveredNode] = useState<MemoryNodeData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [isSimulating, setIsSimulating] = useState(true);

  const activeDisplayNode = selectedNode || hoveredNode;

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      <main className="app-stage">
        <AppTopbar
          title="记忆图谱 (Memory Graph Engineering)"
          badge={<Chip active>124 篇记忆 · 286 条双链 · 25 BPM 共息</Chip>}
          rightActions={
            <div className="telemetry-pill">
              <span className="u-microlabel">图谱数据源</span>
              <span className="val" style={{ color: 'var(--state-done)' }}>GET /api/memory/graph</span>
            </div>
          }
        />

        <div className="graph-stage-wrapper">
          <GraphControls
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            typeFilter={typeFilter}
            onTypeFilterChange={setTypeFilter}
            counts={graphData.counts}
            totalNodes={graphData.nodes.length}
            totalEdges={graphData.edges.length}
            isSimulating={isSimulating}
            onToggleSimulation={() => setIsSimulating(!isSimulating)}
          />

          <CanvasGraph
            nodes={graphData.nodes}
            edges={graphData.edges}
            selectedNodeId={selectedNode?.id}
            searchQuery={searchQuery}
            typeFilter={typeFilter}
            isSimulating={isSimulating}
            onSelectNode={setSelectedNode}
            onHoverNode={setHoveredNode}
          />

          <GraphInspector
            node={activeDisplayNode}
            onClose={() => setSelectedNode(null)}
            onNavigateNode={(targetId) => {
              const target = graphData.nodes.find((n) => n.id === targetId);
              if (target) setSelectedNode(target);
            }}
          />
        </div>
      </main>
    </div>
  );
};
