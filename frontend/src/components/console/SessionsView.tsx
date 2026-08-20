import React, { useState } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { StateLamp } from '@/design-system/tokens';

export interface SessionsViewProps {
  onSelectSession?: (id: string) => void;
}

export const SessionsView: React.FC<SessionsViewProps> = ({ onSelectSession }) => {
  const [filterQuery, setFilterQuery] = useState('');

  const sessions = [
    {
      id: 'sess-8402',
      state: 'running' as StateLamp,
      title: '分布式认证令牌轮转与流式事件管道重构',
      cwd: '/Users/leo/Documents/kimi/workspace/agos-frontend',
      model: 'DeepSeek-V3',
      turns: 8,
      steps: 34,
      tokens: 38420,
      cost: '¥ 0.28',
      updatedAt: '刚刚',
    },
    {
      id: 'sess-8399',
      state: 'done' as StateLamp,
      title: 'PostgreSQL DataConnect 模式迁移回归',
      cwd: '/Users/leo/Documents/kimi/workspace/db-layer',
      model: 'Claude-3.5',
      turns: 14,
      steps: 52,
      tokens: 52100,
      cost: '¥ 1.45',
      updatedAt: '1小时前',
    },
    {
      id: 'sess-8390',
      state: 'failed' as StateLamp,
      title: 'Seccomp 宿主内核隔离逃逸巡检',
      cwd: '/Users/leo/Documents/kimi/workspace/sandbox',
      model: 'DeepSeek-V3',
      turns: 22,
      steps: 88,
      tokens: 84000,
      cost: '¥ 0.58',
      updatedAt: '3小时前',
    },
    {
      id: 'sess-8382',
      state: 'done' as StateLamp,
      title: 'AgOS 遥测甲板设计系统 Token 提取',
      cwd: '/Users/leo/Documents/kimi/workspace/agos-frontend',
      model: 'Kimi-K1.5',
      turns: 5,
      steps: 19,
      tokens: 19800,
      cost: '¥ 0.12',
      updatedAt: '昨天',
    },
    {
      id: 'sess-8370',
      state: 'queued' as StateLamp,
      title: 'WebSocket 事件多路复用连接池压测',
      cwd: '/Users/leo/Documents/kimi/workspace/mux-net',
      model: 'Qwen-2.5',
      turns: 18,
      steps: 64,
      tokens: 41200,
      cost: '¥ 0.32',
      updatedAt: '2天前',
    },
  ];

  const filtered = sessions.filter(
    (s) =>
      s.title.toLowerCase().includes(filterQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800 }}>全量会话高密度审计矩阵</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            覆盖 Token 水位、步长 (Steps)、推理费用与工作区 CWD 归属
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            placeholder="过滤会话主题 / ID..."
            className="form-input"
            style={{ width: '220px', height: '30px', padding: '4px 10px', fontSize: '11.5px' }}
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="telemetry-table-wrap">
        <table className="telemetry-table">
          <thead>
            <tr>
              <th style={{ width: '40px' }}>状态</th>
              <th>会话 ID / 主题 / CWD</th>
              <th style={{ width: '130px' }}>主力模型</th>
              <th style={{ width: '90px' }} className="u-num">轮次 / 步骤</th>
              <th style={{ width: '110px' }} className="u-num">Token 吞吐</th>
              <th style={{ width: '90px' }} className="u-num">预估费用</th>
              <th style={{ width: '100px' }}>更新时间</th>
              <th style={{ width: '110px', textAlign: 'right' }}>快捷操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id}>
                <td><Dot state={s.state} /></td>
                <td>
                  <div style={{ fontWeight: 600, color: s.state === 'failed' ? 'var(--state-failed)' : 'var(--text-primary)' }}>
                    {s.title}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                    #{s.id} · {s.cwd}
                  </div>
                </td>
                <td><Chip active={s.state === 'running'}>{s.model}</Chip></td>
                <td className="u-num">{s.turns} / {s.steps}</td>
                <td className="u-num" style={s.state === 'running' ? { color: 'var(--state-running)', fontWeight: 700 } : undefined}>
                  {(s.tokens / 1000).toFixed(1)}k
                </td>
                <td className="u-num" style={{ color: 'var(--accent-amber)', fontWeight: 600 }}>{s.cost}</td>
                <td className="u-num">{s.updatedAt}</td>
                <td style={{ textAlign: 'right' }}>
                  <Button variant="ghost" size="sm" onClick={() => onSelectSession?.(s.id)}>
                    接入 →
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
