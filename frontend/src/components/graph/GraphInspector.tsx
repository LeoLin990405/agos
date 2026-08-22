import React from 'react';
import type { MemoryEdgeData, MemoryNodeData } from './mock-graph-data';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { MEMORY_TYPE_DEFS } from '@/design-system/tokens';
import {
  hopLists,
  supersedesLineage,
  temporalStatus,
  type GraphEngineering,
  type TemporalStatus,
} from '@/pages/memory-graph-engineering';
import { formatSessionMemoryTime, type SessionMemoryItem } from '@/components/stage/session-memory-model';
import { SESSION_KIND_LABELS } from '@/components/stage/session-memory-presentation';
import {
  SKILLS_USAGE_READY_COPY,
  skillUsageHonesty,
  type SkillCatalogEntry,
  type SkillUsageStat,
} from '@/components/console/skills-model';

export interface GraphInspectorProps {
  node: MemoryNodeData | null;
  episode?: SessionMemoryItem | null;
  skill?: SkillCatalogEntry | null;
  skillUsage?: SkillUsageStat;
  edges: MemoryEdgeData[];
  engineering?: GraphEngineering;
  pathFromPrevious?: readonly string[];
  activation?: number;
  now?: number;
  onClose?: () => void;
  onNavigateNode?: (id: string) => void;
  onOpenStudio?: () => void;
}

type EdgeGroup = {
  title: string;
  empty: string;
  edges: MemoryEdgeData[];
  targetOf: (edge: MemoryEdgeData) => string;
  direction: string;
};

const resolutionLabel: Record<MemoryEdgeData['resolution'], string> = {
  direct: '直接命中',
  normalized: '路径归一',
  dead: '真死链',
  nonMemory: '非记忆目标',
};

const temporalLabel: Record<TemporalStatus, string> = {
  current: '时效仍有效',
  expired: '已过失效时间',
  uncollected: '失效时间未采集',
};

function RelationGroup({ group, onNavigateNode }: { group: EdgeGroup; onNavigateNode?: (id: string) => void }) {
  return (
    <section className="mem-inspector-section">
      <span className="u-microlabel">{group.title}</span>
      {group.edges.length === 0 ? (
        <span className="mem-inspector-empty-line">{group.empty}</span>
      ) : group.edges.map((edge, index) => {
        const target = group.targetOf(edge);
        const canNavigate = !edge.dangling;
        return (
          <button
            key={`${edge.from}:${edge.to}:${edge.kind}:${index}`}
            type="button"
            className={`mem-rel${edge.dangling ? ' is-dead' : ''}`}
            disabled={!canNavigate}
            onClick={() => { if (canNavigate) onNavigateNode?.(target); }}
          >
            <span aria-hidden="true">{edge.kind === 'supersedes' ? group.direction : edge.dangling ? '!' : '→'}</span>
            <code>{target}</code>
            <span className="u-microlabel" style={{ color: 'inherit', whiteSpace: 'nowrap' }}>
              {resolutionLabel[edge.resolution]}
            </span>
          </button>
        );
      })}
    </section>
  );
}

function NeighborList({
  title,
  empty,
  ids,
  onNavigateNode,
}: {
  title: string;
  empty: string;
  ids: readonly string[];
  onNavigateNode?: (id: string) => void;
}) {
  return (
    <section className="mem-inspector-section">
      <span className="u-microlabel">{title}</span>
      {ids.length === 0 ? (
        <span className="mem-inspector-empty-line">{empty}</span>
      ) : ids.map((id) => (
        <button key={id} type="button" className="mem-rel" onClick={() => onNavigateNode?.(id)}>
          <span aria-hidden="true">·</span>
          <code>{id}</code>
          <span className="u-microlabel">打开</span>
        </button>
      ))}
    </section>
  );
}

export const GraphInspector: React.FC<GraphInspectorProps> = ({
  node,
  episode = null,
  skill = null,
  skillUsage,
  edges,
  engineering,
  pathFromPrevious,
  activation,
  now = Date.now(),
  onClose,
  onNavigateNode,
  onOpenStudio,
}) => {
  if (skill) {
    return (
      <aside className="graph-inspector-drawer">
        <div className="mem-inspector-head">
          <Chip>{skill.modelInvocable ? '模型可调' : '仅用户'}</Chip>
          {skillUsage !== undefined && <Chip>{SKILLS_USAGE_READY_COPY}</Chip>}
          {onClose && <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭记忆检查器">×</Button>}
        </div>
        <div>
          <h2 className="mem-inspector-title">{skill.name}</h2>
          <div className="mem-inspector-slug">{skill.category}</div>
          <div className="mem-inspector-meta">
            <span className="u-microlabel">技能层</span>
            <span className="u-microlabel">
              {skill.servedToModel === true ? '模型在用' : skill.servedToModel === false ? '未进模型根' : '是否进模型根未采集'}
            </span>
          </div>
        </div>
        <div className="mem-inspector-body">{skill.description || '该技能没有 description。'}</div>
        {skill.whenToUse && (
          <section className="mem-inspector-section">
            <span className="u-microlabel">何时使用</span>
            <span className="mem-inspector-empty-line">{skill.whenToUse}</span>
          </section>
        )}
        <p className="mem-inspector-empty-line">
          技能不是星图文档。是否写入长期图谱未采集。 {skillUsageHonesty(skillUsage)}
        </p>
        <div className="mem-inspector-foot">
          <span>{skill.root ? <code>{skill.root}</code> : '根未采集'}</span>
          {onOpenStudio && (
            <Button size="sm" variant="ghost" onClick={onOpenStudio}>在工作室打开</Button>
          )}
        </div>
      </aside>
    );
  }

  if (episode) {
    return (
      <aside className="graph-inspector-drawer">
        <div className="mem-inspector-head">
          <Chip variant="amber">{SESSION_KIND_LABELS[episode.kind]}</Chip>
          {onClose && <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭记忆检查器">×</Button>}
        </div>
        <div>
          <h2 className="mem-inspector-title">情节条目</h2>
          <div className="mem-inspector-slug">#{episode.id}</div>
          <div className="mem-inspector-meta">
            <span className="u-microlabel">情节层</span>
            <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>重要度 {episode.importance}</span>
            <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {episode.sourceTurn === 0 ? '会话开始' : `第 ${episode.sourceTurn} 轮`}
            </span>
          </div>
        </div>
        <div className="mem-inspector-body">{episode.text}</div>
        <p className="mem-inspector-empty-line">是否写入长期图谱未采集。这里不把情节条目画成文档节点。</p>
        <div className="mem-inspector-foot">
          <span>提炼: <strong className="u-num">{formatSessionMemoryTime(episode.createdAt)}</strong></span>
        </div>
      </aside>
    );
  }

  if (!node) {
    return (
      <aside className="graph-inspector-drawer">
        <div className="mem-inspector-empty">
          <strong>选择星图文档、情节条目或技能</strong>
          <p>
            节点是长期记忆文件。情节来自会话提炼，技能来自根并集目录。对不上 slug 就不连线。
          </p>
        </div>
      </aside>
    );
  }

  const typeMeta = MEMORY_TYPE_DEFS[node.type];
  const dateStr = new Date(node.mtime).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const validUntil = node.validUntil === undefined ? undefined : new Date(node.validUntil).toLocaleString('zh-CN', { hour12: false });
  const temporal = temporalStatus(node.validUntil, now);
  const degrees = engineering?.degrees.get(node.id);
  const componentId = engineering?.componentByNode.get(node.id);
  const component = componentId === undefined
    ? undefined
    : engineering?.components.find((entry) => entry.id === componentId);
  const hops = hopLists(node.id, edges);
  const lineage = supersedesLineage(node.id, edges);
  const groups: EdgeGroup[] = [
    {
      title: 'Wikilink 出边',
      empty: '没有已解析的出边。',
      edges: edges.filter((edge) => edge.kind === 'wikilink' && edge.from === node.id && !edge.dangling),
      targetOf: (edge) => edge.to,
      direction: '→',
    },
    {
      title: '未解析 Wikilink',
      empty: '没有悬挂链接。',
      edges: edges.filter((edge) => edge.kind === 'wikilink' && edge.from === node.id && edge.dangling),
      targetOf: (edge) => edge.to,
      direction: '→',
    },
    {
      title: '取代的旧记忆',
      empty: '没有 supersedes 出边。',
      edges: edges.filter((edge) => edge.kind === 'supersedes' && edge.from === node.id),
      targetOf: (edge) => edge.to,
      direction: '⇒',
    },
    {
      title: '被新记忆取代',
      empty: '没有指向此节点的 supersedes 边。',
      edges: edges.filter((edge) => edge.kind === 'supersedes' && edge.to === node.id),
      targetOf: (edge) => edge.from,
      direction: '⇐',
    },
  ];

  return (
    <aside className="graph-inspector-drawer">
      <div className="mem-inspector-head">
        <Chip
          style={{
            backgroundColor: typeMeta.colorBg,
            color: typeMeta.color,
            borderColor: `${typeMeta.color}40`,
            fontWeight: 700,
          }}
        >
          {typeMeta.label}
        </Chip>
        {onClose && <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭记忆检查器">×</Button>}
      </div>

      <div>
        <h2 className="mem-inspector-title">{node.title}</h2>
        <div className="mem-inspector-slug">#{node.id}</div>
        <div className="mem-inspector-meta">
          <span className="u-microlabel">原始类型 {node.sourceType}</span>
          <span className="u-microlabel">语义文档</span>
          <Chip variant={temporal === 'expired' ? 'amber' : 'default'}>{temporalLabel[temporal]}</Chip>
          {validUntil && <Chip variant="amber">失效于 {validUntil}</Chip>}
        </div>
        <div className="mem-inspector-stats">
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            出度 {degrees?.outDegree ?? node.outDegree} · 入度 {degrees?.inDegree ?? '未采集'}
          </span>
          {component && (
            <span className="u-microlabel">
              连通分量 {component.id} · {component.size} 篇{component.isolate ? ' · 孤立' : ''}
            </span>
          )}
          {activation !== undefined && (
            <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              种子激活 {activation.toFixed(4)}
            </span>
          )}
        </div>
      </div>

      <div className="mem-inspector-body">
        {node.description || '该记忆没有 description 摘要。'}
      </div>

      <NeighborList
        title="1 跳邻域"
        empty="没有已解析的相邻文档。"
        ids={hops.hop1}
        onNavigateNode={onNavigateNode}
      />
      <NeighborList
        title="2 跳邻域"
        empty="没有第二跳文档。"
        ids={hops.hop2}
        onNavigateNode={onNavigateNode}
      />

      <section className="mem-inspector-section">
        <span className="u-microlabel">时间谱系</span>
        {lineage.chain.length <= 1 ? (
          <span className="mem-inspector-empty-line">这条文档没有 supersedes 链。</span>
        ) : (
          <span className="mem-inspector-empty-line">
            {lineage.chain.join(' ⇒ ')}
          </span>
        )}
      </section>

      {pathFromPrevious && pathFromPrevious.length > 1 && (
        <section className="mem-inspector-section">
          <span className="u-microlabel">到上一选中的最短路</span>
          <span className="mem-inspector-empty-line">{pathFromPrevious.join(' → ')}</span>
        </section>
      )}

      {groups.map((group) => (
        <RelationGroup key={group.title} group={group} onNavigateNode={onNavigateNode} />
      ))}

      <div className="mem-inspector-foot">
        <span>大小: <strong className="u-num">{node.bytes} B</strong></span>
        <span>更新: <strong className="u-num">{dateStr}</strong></span>
      </div>
    </aside>
  );
};
