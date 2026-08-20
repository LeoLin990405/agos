import React, { useState } from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Badge } from '@/components/ui/Badge';
import { StateLamp } from '@/design-system/tokens';

export const PlansView: React.FC = () => {
  const [openPlanId, setOpenPlanId] = useState<string>('plan-01');

  const plans = [
    {
      id: 'plan-01',
      title: 'AgOS 遥测甲板 V2 旗舰设计系统重构与全能力映射',
      goal: '全面升级设计语言，对手册 55 项 RPC 与插件路由实现 1:1 页面化映射',
      state: 'running' as StateLamp,
      progress: '4 / 5 步骤完成',
      updatedAt: '刚刚',
      steps: [
        { index: 1, title: '编写 DESIGN_V2_PLAN.md 确立美学标准与 Token 表', state: 'done' as StateLamp },
        { index: 2, title: '升级 tokens.css、layout.css、deck.css 与 2400ms 共息引擎', state: 'done' as StateLamp },
        { index: 3, title: '构建 Canvas 120+ 节点记忆图谱 (Graph Engineering)', state: 'done' as StateLamp },
        { index: 4, title: '实现控制台六大功能面 (概览/机器/会话/谱系/计划/技能)', state: 'running' as StateLamp },
        { index: 5, title: '执行 npm run typecheck 与 build 全量冒烟验证', state: 'queued' as StateLamp },
      ],
    },
    {
      id: 'plan-02',
      title: '分布式认证租约与令牌自动轮转安全加固',
      goal: '消除 Redis 哨兵切换过程中的并发冲突，完成 8 节点 Swarm 回归',
      state: 'done' as StateLamp,
      progress: '3 / 3 步骤完成',
      updatedAt: '3小时前',
      steps: [
        { index: 1, title: '定位 auth_matrix.go 中 18ms 并发竞争窗', state: 'done' as StateLamp },
        { index: 2, title: '引入 LockManager 分布式互斥租约与原子刷新', state: 'done' as StateLamp },
        { index: 3, title: '拉起 8 节点并发 Fuzzing 验证零漏报', state: 'done' as StateLamp },
      ],
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800 }}>目标与计划归档库 (Plans & Goals)</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            数据源: <code>/api/cn/plans</code> · 严格追踪每步前置依赖与状态
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {plans.map((p) => {
          const isOpen = openPlanId === p.id;
          return (
            <div
              key={p.id}
              style={{
                backgroundColor: 'var(--bg-layer-2)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '10px',
                padding: '16px 20px',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                onClick={() => setOpenPlanId(isOpen ? '' : p.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <Dot state={p.state} />
                  <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>
                    {p.title}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span className="u-num" style={{ fontSize: '11.5px', color: p.state === 'running' ? 'var(--state-running)' : 'var(--text-tertiary)', fontWeight: 600 }}>
                    {p.progress}
                  </span>
                  <Badge state={p.state}>{p.state.toUpperCase()}</Badge>
                </div>
              </div>

              {isOpen && (
                <div style={{ marginTop: '14px', paddingTop: '14px', borderTop: '1px dashed var(--border-dim)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    <span className="u-microlabel">核心目标:</span> {p.goal}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                    {p.steps.map((st) => (
                      <div
                        key={st.index}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          backgroundColor: 'var(--bg-layer-1)',
                          borderRadius: '6px',
                          border: '1px solid var(--border-dim)',
                          fontSize: '12px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <span className="u-num" style={{ color: 'var(--text-tertiary)', minWidth: '20px' }}>0{st.index}</span>
                          <Dot state={st.state} size={6} />
                          <span style={{ color: st.state === 'running' ? 'var(--state-running)' : 'inherit', fontWeight: st.state === 'running' ? 600 : 400 }}>
                            {st.title}
                          </span>
                        </div>
                        <span className="u-microlabel" style={{ color: st.state === 'running' ? 'var(--state-running)' : 'var(--text-tertiary)' }}>
                          {st.state.toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
