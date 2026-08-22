import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Button } from '@/components/ui/Button';
import { StateLamp } from '@/design-system/tokens';

export interface SessionRowData {
  id: string;
  state: StateLamp;
  title: string;
  subtitle: string;
  tokenWatermark: string;
  tokenRatio?: number;
  updatedAt: string;
  actionText: string;
  onAction?: () => void;
}

export interface SessionMatrixProps {
  sessions: SessionRowData[];
}

export const SessionMatrix: React.FC<SessionMatrixProps> = ({ sessions }) => {
  return (
    <section className="surface-stack">
      <div className="inbox-head">
        <span className="surface-kicker">活跃会话遥测矩阵</span>
        <span className="u-num surface-quiet">
          实时排班表 · 共 {sessions.length} 条记录
        </span>
      </div>

      <div className="telemetry-table-wrap">
        <table className="telemetry-table">
          <thead>
            <tr>
              <th className="table-col-state">状态</th>
              <th>会话主题 / 任务</th>
              <th className="u-num table-col-time">Token 水位</th>
              <th className="table-col-time">更新时间</th>
              <th className="table-col-action">操作</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((row) => (
              <tr key={row.id} className={row.state === 'running' ? 'is-running' : row.state === 'failed' ? 'is-failed' : undefined}>
                <td><Dot state={row.state} /></td>
                <td>
                  <div className={`table-title${row.state === 'failed' ? ' is-fail' : ''}`}>
                    {row.title}
                  </div>
                  <div className={`table-id${row.state === 'failed' ? ' is-fail' : ''}`}>
                    {row.subtitle}
                  </div>
                </td>
                <td className={`u-num${row.state === 'running' ? ' table-num-hot' : ''}`}>
                  <div className="table-token">
                    <span>{row.tokenWatermark}</span>
                    {row.tokenRatio !== undefined && (
                      <span className="viz-track table-token-track" aria-hidden="true">
                        <span className="viz-fill" style={{ ['--u-p' as string]: row.tokenRatio }} />
                      </span>
                    )}
                  </div>
                </td>
                <td className="u-num">{row.updatedAt}</td>
                <td className="table-cell-end">
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
