import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { StateLamp } from '@/design-system/tokens';

export interface BladeData {
  id: string;
  name: string;
  role: string;
  state: StateLamp;
  cpu: string;
  memory: string;
  latency: string;
}

export interface FleetRackProps {
  blades: BladeData[];
}

export const FleetRack: React.FC<FleetRackProps> = ({ blades }) => {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 700 }}>物理机房机架阵列 ({blades.length} Nodes Active)</span>
        <Chip style={{ color: 'var(--state-done)', borderColor: 'var(--state-done-border)' }}>
          100% HEALTHY
        </Chip>
      </div>

      <div className="fleet-rack-grid">
        {blades.map((blade) => (
          <div key={blade.id} className="fleet-rack-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{blade.name}</span>
              <Dot state={blade.state} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--text-tertiary)' }}>
              <span>CPU: {blade.cpu}</span>
              <span>MEM: {blade.memory}</span>
              <span className="u-num">P95: {blade.latency}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
