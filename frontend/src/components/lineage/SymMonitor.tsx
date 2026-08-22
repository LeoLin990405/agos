import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { MOTION_CONSTANTS } from '@/design-system/tokens';

export interface SymMonitorProps {
  runningCount: number;
  periodMs?: number;
}

export const SymMonitor: React.FC<SymMonitorProps> = ({
  runningCount,
  periodMs = MOTION_CONSTANTS.PULSE_DURATION_MS,
}) => {
  if (runningCount <= 0) return null;

  return (
    <section className="sym-monitor-banner" aria-label="运行中子任务">
      <div className="sym-pulse-indicator">
        <Dot state="running" size={8} />
        <div>
          <div className="surface-kicker">{runningCount} 个子任务在跑</div>
          <div className="surface-quiet">
            运行灯锁相 <span className="u-num">{periodMs}ms</span>
          </div>
        </div>
      </div>
    </section>
  );
};
