import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/** W16:收件箱的四个来源。副标题由它们算出,不再写死「来自 /api/swarm/progress」。 */
export type InboxSource = 'progress' | 'routes' | 'skills' | 'council';
/** ready = 本轮拿到数据;stale = 拿到过、本轮刷新失败沿用旧数据;absent = 没拿到过。 */
export type InboxSourceState = Record<InboxSource, 'ready' | 'stale' | 'absent'>;

export const INBOX_SOURCE_LABEL: Record<InboxSource, string> = {
  progress: '谱系进度',
  routes: '路由台账',
  skills: '技能审计',
  council: '评审台账',
};

/**
 * 副标题与空态文案都从 sources 算出:
 *  - 列出已采集的来源;缺席的来源点名「未采集」;
 *  - 条目为空时:四源全 ready → 「无待处理」;否则只能说「已采集的来源里无待处理」并点名缺席源——
 *    缺席不是空,不能替它说没事。
 */
const ALL_SOURCES = Object.keys(INBOX_SOURCE_LABEL) as InboxSource[];
const names = (ks: InboxSource[]): string => ks.map((k) => INBOX_SOURCE_LABEL[k]).join('、');

export function inboxSubtitle(sources: InboxSourceState): string {
  const ready = ALL_SOURCES.filter((k) => sources[k] === 'ready');
  const stale = ALL_SOURCES.filter((k) => sources[k] === 'stale');
  const absent = ALL_SOURCES.filter((k) => sources[k] === 'absent');
  const parts: string[] = [];
  parts.push(ready.length === 0 && stale.length === 0 ? '四个来源均未采集' : `来源:${names([...ready, ...stale])}`);
  if (stale.length > 0) parts.push(`更新失败、沿用旧数据:${names(stale)}`);
  if (absent.length > 0) parts.push(`未采集:${names(absent)}`);
  parts.push('失败 > 警告 > 在跑');
  return parts.join(' · ');
}

export function inboxEmptyText(sources: InboxSourceState): string {
  const absent = ALL_SOURCES.filter((k) => sources[k] === 'absent');
  const stale = ALL_SOURCES.filter((k) => sources[k] === 'stale');
  if (absent.length === 0 && stale.length === 0) return '无待处理';
  if (absent.length === 4) return '四个来源均未采集,待处理数未知';
  const bits: string[] = [];
  if (absent.length > 0) bits.push(`未采集:${names(absent)}`);
  if (stale.length > 0) bits.push(`沿用旧数据:${names(stale)}`);
  return `已采集的来源里无待处理;${bits.join(';')}`;
}

/** 徽章状态也由来源算:有条目按最重的那条;空且四源 ready 才是 done;否则是「未知」(queued)。 */
export function inboxBadgeState(items: readonly { type: InboxItemData['type'] }[], sources: InboxSourceState): 'failed' | 'queued' | 'done' {
  if (items.some((it) => it.type === 'error')) return 'failed';
  if (items.length > 0) return 'queued';
  return ALL_SOURCES.every((k) => sources[k] === 'ready') ? 'done' : 'queued';
}

export interface InboxItemData {
  id: string;
  type: 'error' | 'warning' | 'running';
  source: InboxSource;
  title: string;
  description: string;
  timestamp: string;
  actionText: string;
  badgeText?: string;
  onAction?: () => void;
}

export interface AttentionInboxProps {
  items: InboxItemData[];
  /** 必填:副标题、空态、徽章全由它算;没有来源状态就没有资格说「无待处理」。 */
  sources: InboxSourceState;
  /** 由数据算出的附注(例:评审台账只回最近 30 条)。 */
  notes?: readonly string[];
}

export const AttentionInbox: React.FC<AttentionInboxProps> = ({ items, sources, notes = [] }) => {
  return (
    <section className="inbox-section" aria-label="注意力收件箱">
      <div className="inbox-head">
        <div className="surface-cluster">
          <span className="surface-kicker">注意力收件箱 (Attention Inbox)</span>
          <Badge state={inboxBadgeState(items, sources)}>{items.length} 待处理</Badge>
        </div>
        <span className="surface-quiet" data-inbox-sources>
          {inboxSubtitle(sources)}{notes.length > 0 ? ` · ${notes.join(' · ')}` : ''}
        </span>
      </div>

      {items.length === 0 && (
        <p role="status" className="surface-quiet" data-inbox-empty>{inboxEmptyText(sources)}</p>
      )}

      <div className="inbox-list">
        {items.map((item, index) => (
          <div
            key={item.id}
            className={`inbox-item viz-enter ${
              item.type === 'error'
                ? 'inbox-item--error'
                : item.type === 'warning'
                ? 'inbox-item--warning'
                : 'inbox-item--running'
            }`}
            style={{ ['--i' as string]: index }}
          >
            <div className="inbox-copy">
              <Dot state={item.type === 'error' ? 'failed' : item.type === 'warning' ? 'queued' : 'running'} />
              <div>
                <div className="table-title">
                  {item.title}
                </div>
                <div className="table-id">
                  {item.description}
                </div>
              </div>
            </div>
            <div className="inbox-actions">
              {item.badgeText && (
                <Badge state="running">
                  {item.badgeText}
                </Badge>
              )}
              <span className="u-num surface-quiet">
                {item.timestamp}
              </span>
              <Button
                variant={item.type === 'error' ? 'primary' : 'secondary'}
                size="sm"
                onClick={item.onAction}
              >
                {item.actionText}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
