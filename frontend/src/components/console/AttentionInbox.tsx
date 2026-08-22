import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export interface InboxItemData {
  id: string;
  type: 'error' | 'warning' | 'running';
  title: string;
  description: string;
  timestamp: string;
  actionText: string;
  badgeText?: string;
  onAction?: () => void;
}

export interface AttentionInboxProps {
  items: InboxItemData[];
}

export const AttentionInbox: React.FC<AttentionInboxProps> = ({ items }) => {
  return (
    <section className="inbox-section">
      <div className="inbox-head">
        <div className="surface-cluster">
          <span className="surface-kicker">注意力收件箱 (Attention Inbox)</span>
          <Badge state="failed">{items.length} 待处理</Badge>
        </div>
        <span className="surface-quiet">
          来自 /api/swarm/progress：失败行优先，其次仍在跑的批次
        </span>
      </div>

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
                variant={item.type === 'warning' ? 'primary' : 'secondary'}
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
