import React, { useState } from 'react';
import { SymMonitor } from '@/components/lineage/SymMonitor';
import { RootNodeCard } from '@/components/lineage/RootNodeCard';
import { LineageJobTree } from '@/components/lineage/LineageJobTree';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Chip } from '@/components/ui/Chip';

export const LineageView: React.FC = () => {
  const [tab, setTab] = useState<'live' | 'history'>('live');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800 }}>智能体任务谱系与血缘拓扑 (Lineage)</h2>
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
            数据源: <code>/api/swarm/progress</code> + <code>/api/civ/runs</code> · 全局 2400ms 锁相
          </p>
        </div>

        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: 'live', label: '⚡ 实时活跃谱系 (2 批次)' },
            { value: 'history', label: '📜 跨重启历史档案 (18 批次)' },
          ]}
        />
      </div>

      {tab === 'live' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {/* 1. 心跳监视器 */}
          <SymMonitor bpm={25.0} periodMs={2400} driftMs={0.1} />

          {/* 2. 根节点 */}
          <RootNodeCard
            name="@orchestrator-main (根调度中枢)"
            model="DeepSeek-V3 · 671B"
            sessionRole="主控制会话"
            description="正在协调 2 个并行 Swarm 批次任务，分发 12 个特化任务子代理"
            duration="18.4s"
            spawnedCount={12}
          />

          {/* 3. 批次 1 */}
          <LineageJobTree
            batchId="BATCH-8402"
            title="认证矩阵与边界安全审计 (8 节点并发)"
            categoryTag="安全巡检 · Civ 多数决"
            completedSummary="5/8 完成 (62.5%)"
            duration="12.8s"
            isRunningBranch={true}
            jobs={[
              {
                id: 'job-1',
                name: 'redis-cluster-failover',
                role: '🎭⛓ 故障注入',
                model: 'DeepSeek-V3',
                duration: '12.8s (处理中)',
                state: 'running',
                badgeText: 'RUNNING',
                defaultOpen: true,
                metrics: [
                  { label: '内存占用', value: '48MB' },
                  { label: '网络 I/O', value: '2.4 MB/s' },
                  { label: '演练阶段', value: 'Sentinel Switchover' },
                ],
                targetPrompt: '模拟 Redis Master 节点网络断开 500ms，验证会话令牌在哨兵重选期间的分布式租约与降级表现。',
                logs: [
                  '[18:42:22] INFO Sent SIGSTOP to redis-master-01',
                  '[18:42:23] INFO Sentinel promoted replica redis-slave-02 to master (elapsed: 142ms)',
                  '[18:42:24] SUCCESS Token rotation retry loop captured failover without request drop',
                ],
              },
              {
                id: 'job-2',
                name: 'sandbox-escape-probe',
                role: '🎭⛓ 越界探针',
                model: 'DeepSeek-V3',
                duration: '8.9s (未成功)',
                state: 'failed',
                badgeText: 'BLOCKED',
                metrics: [
                  { label: '退出代码', value: 'E4012 (SECCOMP_DENIED)' },
                  { label: '隔离级别', value: 'Namespace + Chroot' },
                ],
                targetPrompt: '尝试对宿主设备 /dev/kmem 发起 probe，触发安全防护策略并被内核 seccomp 强行挂起。',
                logs: ['[AUDIT_LOG] Operation forbidden by host policy. Subagent terminated safely.'],
              },
            ]}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ backgroundColor: 'var(--bg-layer-2)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: '13.5px' }}>BATCH-8390: 全量微服务 gRPC 端口模糊测试 (16 节点)</div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>归档时间: 2026-08-19 22:14:00 · 耗时 4m 12s · 0 漏洞</div>
            </div>
            <Chip>已归档</Chip>
          </div>

          <div style={{ backgroundColor: 'var(--bg-layer-2)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: '13.5px' }}>BATCH-8384: Rust 宏系统内存布局与对齐分析 (8 节点)</div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>归档时间: 2026-08-19 18:30:12 · 耗时 1m 45s · 产物已合入</div>
            </div>
            <Chip>已归档</Chip>
          </div>
        </div>
      )}
    </div>
  );
};
