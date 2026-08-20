import React, { useState } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { KpiCard } from '@/components/ui/KpiCard';
import { AttentionInbox } from '@/components/console/AttentionInbox';
import { SessionMatrix } from '@/components/console/SessionMatrix';
import { FleetRack } from '@/components/console/FleetRack';
import { SparseReadiness } from '@/components/console/SparseReadiness';
import { Dot } from '@/components/ui/Dot';

export const ConsolePage: React.FC<{ onNavigateChat?: () => void; onNavigateLineage?: () => void }> = ({
  onNavigateChat,
  onNavigateLineage,
}) => {
  const [densityMode, setDensityMode] = useState<'dense' | 'sparse'>('dense');

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      {/* 内部功能导航 */}
      <nav className="console-nav-rail">
        <div style={{ padding: '4px 8px 10px 8px' }} className="u-microlabel">控制台导航</div>

        <a href="#overview" className="console-nav-item is-active">
          <span>📊 概览遥测</span>
          <Dot state="running" size={6} />
        </a>
        <a href="#fleet" className="console-nav-item">
          <span>🖥️ 机架与节点</span>
          <Chip style={{ height: '16px', padding: '0 4px' }}>4 节点</Chip>
        </a>
        <a href="#sessions" className="console-nav-item">
          <span>💬 会话矩阵</span>
          <span className="u-num" style={{ fontSize: '11px' }}>24</span>
        </a>
        <div className="console-nav-item" style={{ cursor: 'pointer' }} onClick={onNavigateLineage}>
          <span>🧬 智能体谱系</span>
          <Chip variant="purple" style={{ height: '16px', padding: '0 4px' }}>Swarm</Chip>
        </div>
        <a href="#plans" className="console-nav-item">
          <span>📋 计划与目标</span>
          <span className="u-num" style={{ fontSize: '11px' }}>3</span>
        </a>
        <a href="#skills" className="console-nav-item">
          <span>🧩 技能注册表</span>
          <span className="u-num" style={{ fontSize: '11px' }}>14/14</span>
        </a>
      </nav>

      {/* 主展示区 */}
      <main className="app-stage">
        <AppTopbar
          title="AgOS 控制台概览"
          badge={<Chip>CLUSTER: ASIA-EAST-PROD-01</Chip>}
          rightActions={
            <SegmentedControl
              value={densityMode}
              onChange={setDensityMode}
              options={[
                { value: 'dense', label: '⚡ 满载生产模式 (Dense 42 节点)' },
                { value: 'sparse', label: '🌱 初始冷启模式 (Sparse 1 节点)' },
              ]}
            />
          }
        />

        <div className="console-body">
          {densityMode === 'dense' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
              {/* 1. Hero KPI 遥测矩阵 */}
              <section className="kpi-grid">
                <KpiCard
                  label="活跃智能体 / 批次"
                  value="42"
                  unit="/ 7 Swarms"
                  trend="+6 较上小时"
                  subValue="峰值 64 并发"
                  headerRight={<Dot state="running" />}
                />
                <KpiCard
                  label="批次任务吞吐"
                  value="1,840"
                  unit="ops/m"
                  trend="+12.4% 环比"
                  subValue="P95 240ms"
                  headerRight={<Chip active style={{ height: '16px' }}>实时</Chip>}
                />
                <KpiCard
                  label="今日 Token 吞吐"
                  value="14.82"
                  unit="M"
                  subValue="配额充足"
                  trend="预算使用 38.4%"
                  trendType="neutral"
                  headerRight={<Chip variant="purple" style={{ height: '16px' }}>DeepSeek-V3</Chip>}
                />
                <KpiCard
                  label="安全拦截与否决"
                  value={<span style={{ color: 'var(--state-failed)' }}>0.04%</span>}
                  unit="(3次)"
                  trend="1 次特权阻断待决"
                  trendType="down"
                  subValue="CivStrip 护航中"
                  headerRight={<Dot state="failed" />}
                />
                <KpiCard
                  label="端到端响应延时"
                  value="340"
                  unit="ms"
                  trend="极速响应"
                  subValue="0 重试"
                  headerRight={<Chip style={{ height: '16px' }}>WebSocket</Chip>}
                />
              </section>

              {/* 2. 注意力收件箱 */}
              <AttentionInbox
                items={[
                  {
                    id: '1',
                    type: 'error',
                    title: '子代理沙箱越界拦截: subagent-8402-sandbox-escape',
                    description: '[E4012] 尝试访问宿主受限命名空间 /sys/kernel/debug，已被 seccomp 立即截获',
                    timestamp: '3分钟前',
                    actionText: '定位会话',
                    onAction: onNavigateChat,
                  },
                  {
                    id: '2',
                    type: 'warning',
                    title: '特权配置变更待授权: write_to_file /etc/agos/secrets.env',
                    description: '会话 #8402 申请更新 Redis 主从哨兵配置，涉及生产环境变量覆盖',
                    timestamp: '5分钟前',
                    badgeText: '需人工批准',
                    actionText: '前往审批',
                    onAction: onNavigateChat,
                  },
                  {
                    id: '3',
                    type: 'running',
                    title: 'Swarm 批次 #BATCH-8402 正在执行并发审计 (5/8 完成)',
                    description: '当前节点: redis-cluster-failover 正在重放主从切换压测',
                    timestamp: '12.8s 运行中',
                    actionText: '查看谱系',
                    onAction: onNavigateLineage,
                  },
                ]}
              />

              {/* 3. 高密度会话矩阵 */}
              <SessionMatrix
                sessions={[
                  {
                    id: '1',
                    state: 'running',
                    title: '分布式认证令牌轮转与流式事件管道重构',
                    subtitle: 'Swarm #BATCH-8402 8 节点并发执行中',
                    model: 'DeepSeek-V3',
                    tokenWatermark: '38.4k (30%)',
                    latency: '240ms',
                    updatedAt: '刚刚',
                    actionText: '接入',
                    onAction: onNavigateChat,
                  },
                  {
                    id: '2',
                    state: 'done',
                    title: 'PostgreSQL DataConnect 模式迁移回归',
                    subtitle: '14 条迁移脚本全部验证通过，0 冲突',
                    model: 'Claude-3.5',
                    tokenWatermark: '52.1k (41%)',
                    latency: '310ms',
                    updatedAt: '1小时前',
                    actionText: '回放',
                    onAction: onNavigateChat,
                  },
                  {
                    id: '3',
                    state: 'failed',
                    title: 'Seccomp 宿主内核隔离逃逸巡检',
                    subtitle: '[E4012] 宿主命名空间隔离拒绝，已记入审计',
                    model: 'DeepSeek-V3',
                    tokenWatermark: '84.0k (65%)',
                    latency: '420ms',
                    updatedAt: '3小时前',
                    actionText: '排查',
                    onAction: onNavigateChat,
                  },
                  {
                    id: '4',
                    state: 'done',
                    title: 'AgOS 遥测甲板设计系统 Token 提取',
                    subtitle: '完成 6 个动效常量与深浅双模式 CSS 变量抽离',
                    model: 'Kimi-K1.5',
                    tokenWatermark: '19.8k (15%)',
                    latency: '180ms',
                    updatedAt: '昨天',
                    actionText: '查看',
                    onAction: onNavigateChat,
                  },
                ]}
              />

              {/* 4. 机房机架 */}
              <FleetRack
                blades={[
                  { id: '1', name: 'BLADE-01 (Orchestrator)', role: '主中枢', state: 'running', cpu: '42%', memory: '3.2G / 16G', latency: '12ms' },
                  { id: '2', name: 'BLADE-02 (Swarm Worker Alpha)', role: '计算节点', state: 'running', cpu: '78%', memory: '8.4G / 16G', latency: '18ms' },
                  { id: '3', name: 'BLADE-03 (Swarm Worker Beta)', role: '计算节点', state: 'done', cpu: '14% (Idle)', memory: '1.8G / 16G', latency: '8ms' },
                  { id: '4', name: 'BLADE-04 (Sandbox Gateway)', role: '安全网关', state: 'done', cpu: '22%', memory: '2.1G / 16G', latency: '6ms' },
                ]}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
              {/* 冷启待机 KPI */}
              <section className="kpi-grid">
                <KpiCard
                  label="集群状态"
                  value="待机就绪"
                  trend="1 节点健康在线"
                  subValue="0 活跃会话"
                  headerRight={<Dot state="running" />}
                />
                <KpiCard
                  label="MCP 技能注册表"
                  value="14"
                  unit="/ 14 启用"
                  trend="工具全域可用"
                  subValue="0 挂起"
                  headerRight={<Chip active style={{ height: '16px' }}>100% 挂载</Chip>}
                />
                <KpiCard
                  label="本月消耗"
                  value="0.12"
                  unit="M Tokens"
                  trend="预算余量 99.8%"
                  subValue="费用极低"
                  headerRight={<Chip>DeepSeek</Chip>}
                />
                <KpiCard
                  label="安全策略模式"
                  value={<span style={{ color: 'var(--state-done)' }}>严格防御</span>}
                  trend="特权写入需人工授权"
                  subValue="0 越界"
                  headerRight={<Chip variant="purple">CivStrip v2</Chip>}
                />
              </section>

              {/* 就绪清单 */}
              <SparseReadiness
                onStartWorkflow={(wf) => {
                  if (wf === 'lineage-pulse') onNavigateLineage?.();
                  else onNavigateChat?.();
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
