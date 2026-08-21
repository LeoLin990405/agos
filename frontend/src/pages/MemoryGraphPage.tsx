import React, { useEffect, useMemo, useState } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { CanvasGraph } from '@/components/graph/CanvasGraph';
import { GraphInspector } from '@/components/graph/GraphInspector';
import { GraphControls } from '@/components/graph/GraphControls';
import { generateMockMemoryGraph, MemoryNodeData, type MemoryGraphData as UiGraphData } from '@/components/graph/mock-graph-data';
import { fetchMemoryGraph } from '@/stores/live';
import { adaptRealGraph } from './memory-graph-model';

export { adaptRealGraph, TYPE_MAP } from './memory-graph-model';

export const MemoryGraphPage: React.FC = () => {
  const [realData, setRealData] = useState<UiGraphData | undefined>(undefined);
  useEffect(() => { void fetchMemoryGraph().then((d) => setRealData(adaptRealGraph(d))); }, []);
  const graphData = useMemo(() => realData ?? generateMockMemoryGraph(), [realData]);
  const isReal = realData !== undefined;
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
          badge={<Chip active>{graphData.nodes.length} 篇记忆 · {graphData.edges.length} 条双链{isReal ? '' : ' · demo'}</Chip>}
          rightActions={
            <div className="telemetry-pill">
              <span className="u-microlabel">数据源</span>
              <span className="val" style={{ color: isReal ? 'var(--state-done)' : 'var(--text-tertiary)' }}>
                {isReal ? '/api/memory/graph · 实时' : '本地 demo(后端未连)'}
              </span>
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
