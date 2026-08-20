import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { StateLamp } from '@/design-system/tokens';

export interface SessionRowData {
  id: string;
  state: StateLamp;
  title: string;
  subtitle: string;
  model: string;
  tokenWatermark: string;
  latency: string;
  updatedAt: string;
  actionText: string;
  onAction?: () => void;
}

export interface SessionMatrixProps {
  sessions: SessionRowData[];
}

export const SessionMatrix: React.FC<SessionMatrixProps> = ({ sessions }) => {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 700 }}>活跃会话遥测矩阵</span>
        <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          实时排班表 · 共 {sessions.length} 条记录
        </span>
      </div>

      <div className="telemetry-table-wrap">
        <table className="telemetry-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>状态</th>
              <th>会话主题 / 任务</th>
              <th style={{ width: '140px' }}>主力模型</th>
              <th style={{ width: '120px' }} className="u-num">Token 水位</th>
              <th style={{ width: '90px' }} className="u-num">延时 P95</th>
              <th style={{ width: '100px' }}>更新时间</th>
              <th style={{ width: '80px', textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((row) => (
              <tr key={row.id}>
                <td><Dot state={row.state} /></td>
                <td>
                  <div style={{ fontWeight: 600, color: row.state === 'failed' ? 'var(--state-failed)' : 'inherit' }}>
                    {row.title}
                  </div>
                  <div style={{ fontSize: '11px', color: row.state === 'failed' ? 'var(--state-failed)' : 'var(--text-tertiary)' }}>
                    {row.subtitle}
                  </div>
                </td>
                <td><Chip active={row.state === 'running'}>{row.model}</Chip></td>
                <td className="u-num" style={row.state === 'running' ? { fontWeight: 700, color: 'var(--state-running)' } : undefined}>
                  {row.tokenWatermark}
                </td>
                <td className="u-num">{row.latency}</td>
                <td className="u-num">{row.updatedAt}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button variant="ghost" size="sm" onClick={row.onAction}>
                    {row.actionText}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
