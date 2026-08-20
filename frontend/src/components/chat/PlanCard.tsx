import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { StateLamp } from '@/design-system/tokens';

export interface PlanStep {
  index: number;
  title: string;
  state: StateLamp;
}

export interface PlanCardProps {
  planId: string;
  title: string;
  steps: PlanStep[];
}

export const PlanCard: React.FC<PlanCardProps> = ({ planId, title, steps }) => {
  return (
    <div className="plan-run-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '12.5px' }}>
          <span>📋 计划执行: {title}</span>
        </div>
        <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>#{planId}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {steps.map((step) => (
          <div
            key={step.index}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              backgroundColor: 'var(--bg-layer-1)',
              borderRadius: '5px',
              fontSize: '11.5px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="u-num" style={{ color: 'var(--text-tertiary)', minWidth: '18px' }}>0{step.index}</span>
              <Dot state={step.state} size={6} />
              <span style={{ color: step.state === 'running' ? 'var(--state-running)' : 'inherit', fontWeight: step.state === 'running' ? 600 : 400 }}>
                {step.title}
              </span>
            </div>
            <span className="u-microlabel" style={{ color: step.state === 'running' ? 'var(--state-running)' : 'var(--text-tertiary)' }}>
              {step.state.toUpperCase()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
