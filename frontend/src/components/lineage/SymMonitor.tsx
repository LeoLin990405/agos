import React from 'react';
import { Dot } from '@/components/ui/Dot';

export interface SymMonitorProps {
  bpm?: number;
  periodMs?: number;
  driftMs?: number;
}

export const SymMonitor: React.FC<SymMonitorProps> = ({
  bpm = 25.0,
  periodMs = 2400,
  driftMs = 0.1,
}) => {
  return (
    <section className="sym-monitor-banner">
      <div className="sym-pulse-indicator">
        <Dot state="running" size={12} />
        <div>
          <div style={{ fontSize: '13.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
            全局共息同频心跳 (Sym-Respiration: Breathe as One)
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            所有运行中的子代理、进度条流光与侧栏指示灯均已锁相至{' '}
            <span className="u-num" style={{ color: 'var(--state-running)', fontWeight: 800 }}>
              {periodMs}ms
            </span>{' '}
            同一时间基准
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
        <div className="sym-pulse-wave">
          <div className="sym-bar" />
          <div className="sym-bar" />
          <div className="sym-bar" />
          <div className="sym-bar" />
          <div className="sym-bar" />
          <div className="sym-bar" />
          <div className="sym-bar" />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="u-num" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--state-running)' }}>
            {bpm.toFixed(1)} BPM
          </div>
          <div className="u-microlabel">锁相漂移 &lt; {driftMs}ms</div>
        </div>
      </div>
    </section>
  );
};
