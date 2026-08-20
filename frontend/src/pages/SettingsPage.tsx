import React from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export const SettingsPage: React.FC = () => {
  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      <main className="app-stage">
        <AppTopbar
          title="系统安全与凭据设置 (Settings & Security)"
          badge={<Chip style={{ color: 'var(--accent-amber)', borderColor: 'var(--accent-amber)' }}>特权回环限制 (Loopback Only)</Chip>}
          runningState={false}
        />

        <div style={{ flex: 1, overflowY: 'auto', padding: '28px 36px', display: 'flex', flexDirection: 'column', gap: '26px', maxWidth: '1000px' }}>
          {/* 安全警示 */}
          <div
            style={{
              backgroundColor: 'rgba(245, 158, 11, 0.08)',
              border: '1px solid rgba(245, 158, 11, 0.3)',
              borderRadius: '8px',
              padding: '14px 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '18px' }}>🛡️</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--accent-amber)' }}>
                  特权配置受内核沙箱强隔离
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  涉及全局模型 API 密钥与宿主白名单的变更必须通过本机 127.0.0.1 回环环境进行授权。
                </div>
              </div>
            </div>
            <Badge style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: 'var(--accent-amber)' }}>
              READONLY PREVIEW
            </Badge>
          </div>

          {/* 1. 模型提供商与凭据 */}
          <section className="fleet-rack-card">
            <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '6px' }}>模型提供商凭据 (Credentials Vault)</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', backgroundColor: 'var(--bg-layer-1)', borderRadius: '6px', border: '1px solid var(--border-dim)' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '12.5px' }}>DeepSeek API Gateway</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>sk-deepseek-••••••••••••••••38f2 (已加密存储)</div>
                </div>
                <Button variant="ghost" size="sm" disabled>编辑凭据 (特权已锁)</Button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', backgroundColor: 'var(--bg-layer-1)', borderRadius: '6px', border: '1px solid var(--border-dim)' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '12.5px' }}>Anthropic Claude Engine</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>sk-ant-••••••••••••••••99a1 (已加密存储)</div>
                </div>
                <Button variant="ghost" size="sm" disabled>编辑凭据 (特权已锁)</Button>
              </div>
            </div>
          </section>

          {/* 2. 遥测与通信配置 */}
          <section className="fleet-rack-card">
            <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '6px' }}>RPC 网关与长连接 (Typert WS 426)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label className="form-label">宿主 RPC 端口 (Host Port)</label>
                <input type="text" className="form-input" value="127.0.0.1:3091" disabled />
              </div>
              <div className="form-group">
                <label className="form-label">WebSocket Mux 信道</label>
                <input type="text" className="form-input" value="/api/events/mux" disabled />
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
};
