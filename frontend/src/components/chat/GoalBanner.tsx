import React, { useState } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';

export interface GoalBannerProps {
  goalId?: string;
  title: string;
  progressPercent?: number;
  status?: 'active' | 'paused' | 'completed';
  onPause?: () => void;
  onResume?: () => void;
  onComplete?: () => void;
  onClear?: () => void;
}

export const GoalBanner: React.FC<GoalBannerProps> = ({
  goalId = 'GOAL-01',
  title = '完成 AgOS 遥测甲板 V2 旗舰级设计系统与后端能力全映射',
  progressPercent = 65,
  status = 'active',
  onPause,
  onResume,
  onComplete,
  onClear,
}) => {
  const [currentStatus, setCurrentStatus] = useState(status);

  return (
    <div className="goal-banner">
      <div className="goal-banner-left">
        <Dot state={currentStatus === 'active' ? 'running' : currentStatus === 'completed' ? 'done' : 'queued'} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <Chip variant="purple" style={{ height: '18px', padding: '0 5px' }}>
            🎯 目标 #{goalId}
          </Chip>
          <span className="goal-banner-title">{title}</span>
        </div>
      </div>

      <div className="goal-banner-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '8px' }}>
          <div style={{ width: '80px', height: '6px', backgroundColor: 'var(--bg-layer-1)', borderRadius: '3px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${progressPercent}%`,
                height: '100%',
                backgroundColor: currentStatus === 'completed' ? 'var(--state-done)' : 'var(--accent-purple)',
              }}
            />
          </div>
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
            {progressPercent}%
          </span>
        </div>

        {currentStatus === 'active' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCurrentStatus('paused');
              onPause?.();
            }}
            title="暂停目标执行"
          >
            ⏸ 暂停
          </Button>
        )}

        {currentStatus === 'paused' && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setCurrentStatus('active');
              onResume?.();
            }}
            title="继续目标执行"
          >
            ▶ 继续
          </Button>
        )}

        <Button
          variant="success"
          size="sm"
          onClick={() => {
            setCurrentStatus('completed');
            onComplete?.();
          }}
          title="标记目标已达成"
        >
          ✓ 达成
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          title="移除目标横幅"
          style={{ padding: '0 6px' }}
        >
          ✕
        </Button>
      </div>
    </div>
  );
};
