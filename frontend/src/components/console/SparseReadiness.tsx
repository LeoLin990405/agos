import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export interface SparseReadinessProps {
  onStartWorkflow?: (type: string) => void;
}

export const SparseReadiness: React.FC<SparseReadinessProps> = ({ onStartWorkflow }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
      {/* 1. 系统健康就绪清单 */}
      <section className="readiness-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ fontSize: '14.5px', fontWeight: 700 }}>系统冷启环境巡检清单 (System Readiness)</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              所有核心微内核、沙箱管道与 RPC 网关均已处于最佳工作状态。
            </p>
          </div>
          <Badge state="done">ALL CHECKS PASSED</Badge>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
          <div className="readiness-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Dot state="done" />
              <span style={{ fontWeight: 600 }}>Typert Gateway RPC (:3091)</span>
            </div>
            <span className="u-num" style={{ color: 'var(--state-done)', fontSize: '11.5px', fontWeight: 600 }}>
              0.8ms 响应
            </span>
          </div>

          <div className="readiness-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Dot state="done" />
              <span style={{ fontWeight: 600 }}>Seccomp 沙箱隔离层</span>
            </div>
            <span style={{ color: 'var(--state-done)', fontSize: '11.5px', fontWeight: 600 }}>严格激活</span>
          </div>

          <div className="readiness-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Dot state="done" />
              <span style={{ fontWeight: 600 }}>WebSocket 多路复用信道 (426 WS)</span>
            </div>
            <span style={{ color: 'var(--state-done)', fontSize: '11.5px', fontWeight: 600 }}>全双工监听</span>
          </div>

          <div className="readiness-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Dot state="done" />
              <span style={{ fontWeight: 600 }}>本地存储空间 (/var/lib/agos)</span>
            </div>
            <span className="u-num" style={{ color: 'var(--text-tertiary)', fontSize: '11.5px' }}>
              1.2G / 50G (98% 空闲)
            </span>
          </div>
        </div>
      </section>

      {/* 2. 快速启动建议卡片 */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 700 }}>推荐初始工作流</span>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px' }}>
          <div
            className="fleet-rack-card"
            style={{ cursor: 'pointer', borderColor: 'var(--border-bold)' }}
            onClick={() => onStartWorkflow?.('security-audit')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--state-running)' }}>
              <span>🚀 启动代码库架构安全巡检</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              一键拉起 8 节点并发 Swarm 编队，自动化审计 Token 刷新、并发竞争与沙箱边界。
            </div>
            <Button variant="primary" size="sm" style={{ alignSelf: 'flex-start', marginTop: '4px' }}>
              立即启动 →
            </Button>
          </div>

          <div
            className="fleet-rack-card"
            style={{ cursor: 'pointer' }}
            onClick={() => onStartWorkflow?.('refactor-session')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--text-primary)' }}>
              <span>⚡ 创建通用代码重构会话</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              基于 DeepSeek-V3 / Claude 3.5 双模型混编，对指定目录进行模块化重构。
            </div>
            <Button variant="secondary" size="sm" style={{ alignSelf: 'flex-start', marginTop: '4px' }}>
              新建会话 →
            </Button>
          </div>

          <div
            className="fleet-rack-card"
            style={{ cursor: 'pointer' }}
            onClick={() => onStartWorkflow?.('lineage-pulse')}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, color: 'var(--accent-purple)' }}>
              <span>🧬 查看历史谱系与共息波形</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              进入智能体谱系甲板，观测全局 2400ms 锁相同步呼吸心跳与团队拓扑。
            </div>
            <Button variant="secondary" size="sm" style={{ alignSelf: 'flex-start', marginTop: '4px' }}>
              进入谱系 →
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
};
