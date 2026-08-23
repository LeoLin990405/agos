import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/** W16:收件箱的四个来源。副标题由它们算出,不再写死「来自 /api/swarm/progress」。 */
export type InboxSource = 'progress' | 'routes' | 'skills' | 'council';
export type InboxSourceState = Record<InboxSource, 'ready' | 'absent'>;

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
export function inboxSubtitle(sources: InboxSourceState | undefined): string {
  if (sources === undefined) return '来源:谱系进度';
  const ready = (Object.keys(INBOX_SOURCE_LABEL) as InboxSource[]).filter((k) => sources[k] === 'ready');
  const absent = (Object.keys(INBOX_SOURCE_LABEL) as InboxSource[]).filter((k) => sources[k] !== 'ready');
  const head = ready.length === 0 ? '四个来源均未采集' : `来源:${ready.map((k) => INBOX_SOURCE_LABEL[k]).join('、')}`;
  const tail = absent.length === 0 ? '' : ` · 未采集:${absent.map((k) => INBOX_SOURCE_LABEL[k]).join('、')}`;
  return `${head}${tail} · 失败 > 警告 > 在跑`;
}

export function inboxEmptyText(sources: InboxSourceState | undefined): string {
  if (sources === undefined) return '无待处理';
  const absent = (Object.keys(INBOX_SOURCE_LABEL) as InboxSource[]).filter((k) => sources[k] !== 'ready');
  if (absent.length === 0) return '无待处理';
  if (absent.length === 4) return '四个来源均未采集,待处理数未知';
  return `已采集的来源里无待处理;未采集:${absent.map((k) => INBOX_SOURCE_LABEL[k]).join('、')}`;
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
  sources?: InboxSourceState;
}

export const AttentionInbox: React.FC<AttentionInboxProps> = ({ items, sources }) => {
  const hasError = items.some((it) => it.type === 'error');
  return (
    <section className="inbox-section" aria-label="注意力收件箱">
      <div className="inbox-head">
        <div className="surface-cluster">
          <span className="surface-kicker">注意力收件箱 (Attention Inbox)</span>
          <Badge state={items.length === 0 ? 'done' : hasError ? 'failed' : 'queued'}>{items.length} 待处理</Badge>
        </div>
        <span className="surface-quiet" data-inbox-sources>
          {inboxSubtitle(sources)}
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
