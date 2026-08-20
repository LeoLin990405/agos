import React, { useEffect, useMemo, useState } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { CanvasGraph } from '@/components/graph/CanvasGraph';
import { GraphInspector } from '@/components/graph/GraphInspector';
import { GraphControls } from '@/components/graph/GraphControls';
import { generateMockMemoryGraph, MemoryNodeData, type MemoryGraphData as UiGraphData } from '@/components/graph/mock-graph-data';
import type { MemoryNodeType } from '@/design-system/tokens';
import { fetchMemoryGraph } from '@/stores/live';

/** 后端 type → 前端五色族(后端还有 fact/lesson/case/profile/decision 等迁移期类型)。 */
const TYPE_MAP: Record<string, MemoryNodeType> = {
  user: 'user', profile: 'user',
  feedback: 'feedback', lesson: 'feedback',
  project: 'project', 'project-memory': 'project', decision: 'project',
  reference: 'reference', fact: 'reference',
  incident: 'incident', case: 'incident',
};

function adaptRealGraph(d: Awaited<ReturnType<typeof fetchMemoryGraph>>): UiGraphData | undefined {
  if (d === undefined || d.nodes.length === 0) return undefined;
  const out = new Map<string, string[]>();
  for (const e of d.edges) {
    const arr = out.get(e.from) ?? [];
    arr.push(e.to); out.set(e.from, arr);
  }
  const counts = { user: 0, feedback: 0, project: 0, reference: 0, incident: 0 } as Record<MemoryNodeType, number>;
  const nodes = d.nodes.map((n) => {
    const type = TYPE_MAP[n.type] ?? 'reference';
    counts[type] += 1;
    return {
      id: n.id, type, title: n.id, description: n.description,
      bytes: n.bytes, mtime: n.mtime, outDegree: n.outDegree,
      wikilinks: out.get(n.id) ?? [],
    } satisfies MemoryNodeData;
  });
  return { nodes, edges: d.edges.map((e) => ({ from: e.from, to: e.to, dangling: e.dangling })), counts };
}

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
