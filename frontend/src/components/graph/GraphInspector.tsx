import React from 'react';
import type { MemoryEdgeData, MemoryNodeData } from './mock-graph-data';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { MEMORY_TYPE_DEFS } from '@/design-system/tokens';
import {
  collapseIds,
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
  onPromoteEpisode?: (item: SessionMemoryItem) => Promise<string>;
  onSubmitToCiv?: (input: {
    slug: string;
    type: string;
    description: string;
    body: string;
    itemId: string;
  }) => Promise<string>;
  onVoidNode?: (slug: string) => Promise<string>;
  deskCopy?: string;
  civAvailable?: boolean;
  voided?: boolean;
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

function RelationRow({
  edge,
  group,
  onNavigateNode,
}: {
  edge: MemoryEdgeData;
  group: EdgeGroup;
  onNavigateNode?: (id: string) => void;
}) {
  const target = group.targetOf(edge);
  const canNavigate = !edge.dangling;
  return (
    <button
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
}

function RelationGroup({ group, onNavigateNode }: { group: EdgeGroup; onNavigateNode?: (id: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const folded = collapseIds(group.edges.map((_, index) => String(index)));
  const shown = group.edges.slice(0, folded.visible.length);
  return (
    <section className="mem-inspector-section">
      <span className="u-microlabel">{group.title}{group.edges.length > 0 ? ` · ${group.edges.length}` : ''}</span>
      {group.edges.length === 0 ? (
        <span className="mem-inspector-empty-line">{group.empty}</span>
      ) : (
        <>
          {shown.map((edge, index) => (
            <RelationRow
              key={`${edge.from}:${edge.to}:${edge.kind}:${index}`}
              edge={edge}
              group={group}
              onNavigateNode={onNavigateNode}
            />
          ))}
          {folded.hidden > 0 && (
            <button type="button" className="mem-inspector-more-btn" onClick={() => setOpen((value) => !value)}>
              {open ? '收起其余关系' : `其余 ${folded.hidden} 条关系`}
            </button>
          )}
          {open && group.edges.slice(shown.length).map((edge, index) => (
            <RelationRow
              key={`${edge.from}:${edge.to}:${edge.kind}:more:${index}`}
              edge={edge}
              group={group}
              onNavigateNode={onNavigateNode}
            />
          ))}
        </>
      )}
    </section>
  );
}

function NeighborList({
  title,
  empty,
  ids,
  onNavigateNode,
  collapsed = false,
}: {
  title: string;
  empty: string;
  ids: readonly string[];
  onNavigateNode?: (id: string) => void;
  collapsed?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const folded = collapseIds(ids);
  const shown = collapsed ? folded.visible : ids;
  return (
    <section className="mem-inspector-section">
      <span className="u-microlabel">{title}{ids.length > 0 ? ` · ${ids.length}` : ''}</span>
      {ids.length === 0 ? (
        <span className="mem-inspector-empty-line">{empty}</span>
      ) : (
        <>
          {shown.map((id) => (
            <button key={id} type="button" className="mem-rel" onClick={() => onNavigateNode?.(id)}>
              <span aria-hidden="true">·</span>
              <code>{id}</code>
              <span className="u-microlabel">打开</span>
            </button>
          ))}
          {collapsed && folded.hidden > 0 && (
            <button type="button" className="mem-inspector-more-btn" onClick={() => setOpen((value) => !value)}>
              {open ? '收起其余邻域' : `其余 ${folded.hidden} 个邻域`}
            </button>
          )}
          {open && ids.slice(folded.visible.length).map((id) => (
            <button key={`more:${id}`} type="button" className="mem-rel" onClick={() => onNavigateNode?.(id)}>
              <span aria-hidden="true">·</span>
              <code>{id}</code>
              <span className="u-microlabel">打开</span>
            </button>
          ))}
        </>
      )}
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
  onPromoteEpisode,
  onSubmitToCiv,
  onVoidNode,
  deskCopy,
  civAvailable,
  voided = false,
}) => {
  const [deskConfirm, setDeskConfirm] = React.useState(false);
  const [deskNotice, setDeskNotice] = React.useState<string>();
  const [deskBusy, setDeskBusy] = React.useState(false);
  const [submitConfirm, setSubmitConfirm] = React.useState(false);
  const [submitSlug, setSubmitSlug] = React.useState('');
  const [submitType, setSubmitType] = React.useState('project');
  const [submitDescription, setSubmitDescription] = React.useState('');
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
        <p className="mem-inspector-empty-line">这里不把情节条目画成文档节点。</p>
        <div className="desk-gate">
          <span className="u-microlabel">{deskCopy ?? '晋升只写 AgOS 甲板账本，未写入 Fleet Memory 真源。'}</span>
          <label>
            <input type="checkbox" checked={deskConfirm} onChange={(event) => setDeskConfirm(event.target.checked)} />
            确认晋升到甲板账本
          </label>
          <Button
            size="sm"
            disabled={!deskConfirm || deskBusy || onPromoteEpisode === undefined}
            onClick={() => {
              if (onPromoteEpisode === undefined) return;
              setDeskBusy(true);
              void onPromoteEpisode(episode).then((message) => {
                setDeskBusy(false);
                setDeskConfirm(false);
                setDeskNotice(message);
                if (submitDescription === '') setSubmitDescription(episode.text);
              });
            }}
          >
            晋升情节
          </Button>
        </div>
        <div className="desk-gate">
          <span className="u-microlabel">
            {civAvailable === undefined
              ? 'civ 接线未采集'
              : civAvailable
                ? '可单独 confirm 后调 civ memory_submit'
                : '宿主 civ memory_submit 未接线，未写入 Fleet Memory'}
          </span>
          <input
            className="mem-working-select"
            placeholder="project_example_slug"
            value={submitSlug}
            onChange={(event) => setSubmitSlug(event.target.value)}
          />
          <select className="mem-working-select" value={submitType} onChange={(event) => setSubmitType(event.target.value)}>
            <option value="project">project</option>
            <option value="reference">reference</option>
            <option value="feedback">feedback</option>
            <option value="user">user</option>
          </select>
          <input
            className="mem-working-select"
            placeholder="单行召回摘要"
            value={submitDescription}
            onChange={(event) => setSubmitDescription(event.target.value)}
          />
          <label>
            <input type="checkbox" checked={submitConfirm} onChange={(event) => setSubmitConfirm(event.target.checked)} />
            确认送真源
          </label>
          <Button
            size="sm"
            disabled={!submitConfirm || deskBusy || onSubmitToCiv === undefined || submitSlug.trim() === ''}
            onClick={() => {
              if (onSubmitToCiv === undefined) return;
              setDeskBusy(true);
              void onSubmitToCiv({
                slug: submitSlug.trim(),
                type: submitType,
                description: submitDescription.trim() === '' ? episode.text : submitDescription.trim(),
                body: episode.text,
                itemId: episode.id,
              }).then((message) => {
                setDeskBusy(false);
                setSubmitConfirm(false);
                setDeskNotice(message);
              });
            }}
          >
            送 Fleet Memory
          </Button>
        </div>
        {deskNotice && <p className="mem-inspector-empty-line">{deskNotice}</p>}
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
          <Chip variant={temporal === 'expired' || voided ? 'amber' : 'default'}>
            {voided ? '甲板已标记作废' : temporalLabel[temporal]}
          </Chip>
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
        collapsed
      />
      <NeighborList
        title="2 跳邻域"
        empty="没有第二跳文档。"
        ids={hops.hop2}
        onNavigateNode={onNavigateNode}
        collapsed
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

      <div className="desk-gate">
        <span className="u-microlabel">{deskCopy ?? '作废只写 AgOS 甲板账本，未改 Fleet Memory 文件。'}</span>
        <label>
          <input type="checkbox" checked={deskConfirm} onChange={(event) => setDeskConfirm(event.target.checked)} />
          确认标记作废
        </label>
        <Button
          size="sm"
          disabled={!deskConfirm || deskBusy || onVoidNode === undefined || voided}
          onClick={() => {
            if (onVoidNode === undefined) return;
            setDeskBusy(true);
            void onVoidNode(node.id).then((message) => {
              setDeskBusy(false);
              setDeskConfirm(false);
              setDeskNotice(message);
            });
          }}
        >
          标记作废
        </Button>
      </div>
      {deskNotice && <p className="mem-inspector-empty-line">{deskNotice}</p>}
      <div className="mem-inspector-foot">
        <span>大小: <strong className="u-num">{node.bytes} B</strong></span>
        <span>更新: <strong className="u-num">{dateStr}</strong></span>
      </div>
    </aside>
  );
};
