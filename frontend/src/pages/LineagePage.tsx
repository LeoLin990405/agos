import React, { useState } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Chip } from '@/components/ui/Chip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { SymMonitor } from '@/components/lineage/SymMonitor';
import { RootNodeCard } from '@/components/lineage/RootNodeCard';
import { LineageJobTree } from '@/components/lineage/LineageJobTree';
import { StateLamp } from '@/design-system/tokens';

export const LineagePage: React.FC = () => {
  const [filterState, setFilterState] = useState<string>('all');

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      <main className="app-stage">
        <AppTopbar
          title="智能体任务谱系与血缘拓扑"
          badge={<Chip active>共息锁相中 (25 BPM)</Chip>}
          rightActions={
            <SegmentedControl
              value={filterState}
              onChange={setFilterState}
              options={[
                { value: 'all', label: '全部 (12)' },
                { value: 'running', label: <span style={{ color: 'var(--state-running)', fontWeight: 600 }}>处理中 (4)</span> },
                { value: 'queued', label: '等待中 (2)' },
                { value: 'done', label: <span style={{ color: 'var(--state-done)' }}>已完成 (5)</span> },
                { value: 'failed', label: <span style={{ color: 'var(--state-failed)' }}>未成功 (1)</span> },
              ]}
            />
          }
        />

        <div className="lineage-wrapper">
          {/* 1. 共息同频心跳监视器 */}
          <SymMonitor bpm={25.0} periodMs={2400} driftMs={0.1} />

          {/* 2. 根协调器 */}
          <RootNodeCard
            name="@orchestrator-main (根调度中枢)"
            model="DeepSeek-V3 · 671B"
            sessionRole="主控制会话"
            description="正在协调 2 个并行 Swarm 批次任务，分发 12 个特化任务子代理"
            duration="18.4s"
            spawnedCount={12}
          />

          {/* 3. 批次 1: 安全审计 Swarm */}
          <LineageJobTree
            batchId="BATCH-8402"
            title="认证矩阵与边界安全审计 (8 节点并发)"
            categoryTag="安全巡检"
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
              {
                id: 'job-3',
                name: 'auth-crypto-auditor',
                role: '🎭⤴ 加密审计',
                model: 'Claude-3.5',
                duration: '1.2s (已完成)',
                state: 'done',
                badgeText: 'COMPLETED',
                metrics: [
                  { label: '代码覆盖率', value: '98.4%' },
                  { label: '安全漏洞', value: '0 警报' },
                ],
                targetPrompt: '完成 Ed25519 签名算法验证，未发现私钥泄露或侧信道弱随机数风险。',
                logs: ['Report generated: reports/security/crypto_audit_pass.json'],
              },
              {
                id: 'job-4',
                name: 'tls-handshake-loadtest',
                role: '🎭 压测',
                model: 'Qwen-2.5',
                duration: '等待中...',
                state: 'queued',
                badgeText: 'QUEUED',
                metrics: [],
                targetPrompt: '排队等待 #BATCH-8402 释放并发执行槽位（当前并发配额 4/4）。',
                logs: [],
              },
            ]}
          />

          {/* 4. 批次 2: 前端组件工程 */}
          <LineageJobTree
            batchId="BATCH-8399"
            title="AgOS 遥测甲板设计 Token 与组件抽离 (4 节点)"
            categoryTag="前端工程"
            completedSummary="4/4 完成 (100%)"
            duration="8.6s"
            jobs={[
              {
                id: 'job-2-1',
                name: 'tokens-extractor',
                role: 'CSS Token',
                model: 'Kimi-K1.5',
                duration: '2.1s (已完成)',
                state: 'done',
                badgeText: 'COMPLETED',
                metrics: [
                  { label: 'Token 提取数', value: '48 项' },
                  { label: '深浅模式', value: '100% 对齐' },
                ],
                targetPrompt: '从设计稿抽离 CSS Token，输出 tokens.css、layout.css 与 deck.css。',
                logs: ['Tokens exported to src/design-system/'],
              },
            ]}
          />
        </div>
      </main>
    </div>
  );
};
