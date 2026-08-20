import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export const FleetView: React.FC = () => {
  const hosts = [
    {
      id: 'host-asia-01',
      name: 'BLADE-01 (Orchestrator Host)',
      ip: '10.0.1.12',
      arch: 'Darwin x86_64 / Apple Silicon',
      cpu: 42,
      mem: '3.4G / 32G (11%)',
      io: '4.8 MB/s',
      state: 'running' as const,
      role: '主协调中枢',
      uptime: '4d 18h',
      p95: '8.4ms',
    },
    {
      id: 'host-asia-02',
      name: 'BLADE-02 (Swarm Compute Cluster A)',
      ip: '10.0.1.14',
      arch: 'Linux 6.6.13-seccomp-x86_64',
      cpu: 78,
      mem: '14.2G / 64G (22%)',
      io: '38.2 MB/s',
      state: 'running' as const,
      role: '高并发计算阵列',
      uptime: '18d 04h',
      p95: '14.2ms',
    },
    {
      id: 'host-asia-03',
      name: 'BLADE-03 (Swarm Compute Cluster B)',
      ip: '10.0.1.15',
      arch: 'Linux 6.6.13-seccomp-x86_64',
      cpu: 18,
      mem: '6.8G / 64G (10%)',
      io: '1.2 MB/s',
      state: 'done' as const,
      role: '空闲待机节点',
      uptime: '18d 04h',
      p95: '6.1ms',
    },
    {
      id: 'host-asia-04',
      name: 'BLADE-04 (Sandbox & Security Gateway)',
      ip: '10.0.1.20',
      arch: 'Linux 6.6.13-hardened',
      cpu: 26,
      mem: '4.1G / 32G (13%)',
      io: '12.4 MB/s',
      state: 'done' as const,
      role: 'Seccomp 隔离网关',
      uptime: '42d 11h',
      p95: '4.2ms',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800 }}>物理机房机架与节点遥测 (Fleet Hosts)</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            数据源: <code>/api/fleet/hosts</code> · 4 台物理刀片阵列全双工监听
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Chip style={{ color: 'var(--state-done)', borderColor: 'var(--state-done-border)' }}>
            4 / 4 在线 (100% HEALTHY)
          </Chip>
          <Button variant="ghost" size="sm">
            刷新机架
          </Button>
        </div>
      </div>

      <div className="fleet-rack-grid">
        {hosts.map((h) => (
          <div key={h.id} className="fleet-rack-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Dot state={h.state} />
                <span style={{ fontWeight: 700, fontSize: '13.5px', color: 'var(--text-primary)' }}>
                  {h.name}
                </span>
              </div>
              <Badge state={h.state}>{h.state.toUpperCase()}</Badge>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
              <span className="u-num">{h.ip}</span>
              <span>·</span>
              <span>{h.arch}</span>
            </div>

            {/* 资源水位仪表 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', marginBottom: '3px' }}>
                  <span className="u-microlabel">CPU 负载</span>
                  <span className="u-num" style={{ fontWeight: 700, color: h.cpu > 70 ? 'var(--state-failed)' : 'var(--text-primary)' }}>
                    {h.cpu}%
                  </span>
                </div>
                <div style={{ height: '5px', backgroundColor: 'var(--bg-layer-1)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${h.cpu}%`,
                      height: '100%',
                      backgroundColor: h.cpu > 70 ? 'var(--state-failed)' : 'var(--state-running)',
                    }}
                  />
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', marginBottom: '3px' }}>
                  <span className="u-microlabel">内存水位 (RAM)</span>
                  <span className="u-num">{h.mem}</span>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--text-tertiary)', borderTop: '1px solid var(--border-dim)', paddingTop: '8px' }}>
                <span>I/O: <strong className="u-num" style={{ color: 'var(--text-primary)' }}>{h.io}</strong></span>
                <span>P95: <strong className="u-num" style={{ color: 'var(--state-done)' }}>{h.p95}</strong></span>
                <span>运行: <strong className="u-num">{h.uptime}</strong></span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
