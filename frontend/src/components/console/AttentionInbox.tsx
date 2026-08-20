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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '13.5px', fontWeight: 700 }}>注意力收件箱 (Attention Inbox)</span>
          <Badge state="failed">{items.length} 待处理</Badge>
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          按优先级排序: 失败 &gt; 待审批 &gt; 异常波峰
        </span>
      </div>

      <div className="inbox-list">
        {items.map((item) => (
          <div
            key={item.id}
            className={`inbox-item ${
              item.type === 'error'
                ? 'inbox-item--error'
                : item.type === 'warning'
                ? 'inbox-item--warning'
                : 'inbox-item--running'
            }`}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Dot state={item.type === 'error' ? 'failed' : item.type === 'warning' ? 'queued' : 'running'} />
              <div>
                <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--text-primary)' }}>
                  {item.title}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                  {item.description}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {item.badgeText && (
                <Badge style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: 'var(--accent-amber)' }}>
                  {item.badgeText}
                </Badge>
              )}
              <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
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
