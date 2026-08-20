import React, { useState } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { ReasoningBlock } from '@/components/chat/ReasoningBlock';
import { TerminalCard } from '@/components/ui/TerminalCard';
import { DiffCard } from '@/components/ui/DiffCard';
import { SwarmBatchCard } from '@/components/chat/SwarmBatchCard';
import { ApprovalPanel } from '@/components/chat/ApprovalPanel';
import { CommandDeck } from '@/components/chat/CommandDeck';
import { StateLamp } from '@/design-system/tokens';

interface SessionListItem {
  id: string;
  title: string;
  preview: string;
  state: StateLamp;
  tag: string;
  tagVariant?: 'purple' | 'amber';
  meta: string;
  time: string;
}

export const ChatPage: React.FC<{ onNavigateConsole?: () => void }> = ({ onNavigateConsole }) => {
  const [activeSessionId, setActiveSessionId] = useState('1');

  const sessions: SessionListItem[] = [
    {
      id: '1',
      title: '分布式认证令牌轮转与流式事件管道重构',
      preview: '8 节点 Swarm 编队审计中: Redis Failover 模拟中...',
      state: 'running',
      tag: 'P0',
      tagVariant: 'amber',
      meta: '8 条消息 · 38.4k tok',
      time: '刚刚',
    },
    {
      id: '2',
      title: 'PostgreSQL DataConnect 模式迁移回归',
      preview: '数据表迁移脚本已执行完毕，0 冲突',
      state: 'done',
      tag: 'DB',
      meta: '14 条消息 · 52.1k tok',
      time: '1小时前',
    },
    {
      id: '3',
      title: 'Seccomp 宿主内核隔离逃逸巡检',
      preview: '[E4012] 进程被内核 seccomp 截获，已阻断',
      state: 'failed',
      tag: 'SEC',
      meta: '22 条消息 · 84.0k tok',
      time: '3小时前',
    },
    {
      id: '4',
      title: 'AgOS 遥测甲板设计系统 Token 提取',
      preview: '已产出 CSS Token 与共息心跳规范',
      state: 'done',
      tag: 'UI',
      tagVariant: 'purple',
      meta: '5 条消息 · 19.8k tok',
      time: '昨天',
    },
    {
      id: '5',
      title: 'WebSocket 事件多路复用连接池压测',
      preview: '等待前序 CI 编译产物就绪...',
      state: 'queued',
      tag: 'NET',
      meta: '18 条消息 · 41.2k tok',
      time: '2天前',
    },
  ];

  return (
    <div style={{ display: 'flex', flex: 1, height: '100vh', overflow: 'hidden' }}>
      {/* 会话侧栏 */}
      <aside
        style={{
          width: '290px',
          flex: 'none',
          backgroundColor: 'var(--bg-layer-1)',
          borderRight: '1px solid var(--border-dim)',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border-dim)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="u-microlabel">会话矩阵 (24)</span>
            <Button variant="primary" size="sm" style={{ padding: '0 10px', gap: '4px' }}>
              <span style={{ fontSize: '14px', lineHeight: 1 }}>+</span>
              <span>新建会话</span>
            </Button>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              backgroundColor: 'var(--bg-layer-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '7px',
              padding: '6px 12px',
              gap: '8px',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style={{ color: 'var(--text-tertiary)' }}>
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder="搜索历史会话 / 标签..."
              style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '12px', width: '100%', outline: 'none' }}
            />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => setActiveSessionId(s.id)}
              style={{
                padding: '12px 14px',
                borderRadius: '8px',
                backgroundColor: activeSessionId === s.id ? 'var(--bg-layer-2)' : 'transparent',
                border: activeSessionId === s.id ? '1px solid var(--border-subtle)' : '1px solid transparent',
                boxShadow: activeSessionId === s.id ? 'inset 2.5px 0 0 var(--state-running), var(--shadow-card)' : 'none',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <Dot state={s.state} />
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.title}
                  </span>
                </div>
                <Chip variant={s.tagVariant}>{s.tag}</Chip>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {s.preview}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-tertiary)' }}>
                <span className="u-num">{s.meta}</span>
                <span className="u-num" style={s.state === 'running' ? { color: 'var(--state-running)', fontWeight: 600 } : undefined}>
                  {s.time}
                </span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* 舞台 Stage */}
      <main className="app-stage">
        <AppTopbar
          title="分布式认证令牌轮转与流式事件管道重构"
          badge={<Chip active>DeepSeek-V3 · 671B</Chip>}
          rightActions={
            <>
              <div className="telemetry-pill">
                <span className="u-microlabel">上下文水位</span>
                <span className="val u-num">38.4k / 128k</span>
                <span className="u-num" style={{ color: 'var(--accent-cyan)' }}>(30%)</span>
              </div>

              <div className="telemetry-pill">
                <span className="u-microlabel">延时 P95</span>
                <span className="val u-num">240ms</span>
              </div>

              <div className="telemetry-pill">
                <span className="u-microlabel">RPC 管道</span>
                <span className="val" style={{ color: 'var(--state-done)', fontSize: '10.5px' }}>● ONLINE WS 426</span>
              </div>

              <Button variant="ghost" size="sm">导出</Button>
              <Button variant="primary" size="sm" onClick={onNavigateConsole}>控制台概览</Button>
            </>
          }
        />

        {/* 消息滚动流 */}
        <div className="chat-scroll-view">
          {/* 用户 Prompt */}
          <div className="message-wrap">
            <div className="message-user">
              <div className="message-user-header">
                <span style={{ fontWeight: 700, fontSize: '12.5px' }}>Leo (Architect)</span>
                <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>18:42:10</span>
              </div>
              <div style={{ fontSize: '13.5px', lineHeight: 1.6 }}>
                请对 <code>auth-matrix</code> 模块执行深度安全审计与高并发回归。需要拉起 8 节点并发 Swarm 编队，覆盖 Token 重放、内存竞争、Redis Failover 及沙箱边界。最后将修复后的令牌轮转配置写入受保护环境。
              </div>
              <div className="user-attachments">
                <Chip>📎 auth_matrix.go:L1-84</Chip>
                <Chip>📎 jwt_verifier.rs</Chip>
                <Chip>📎 cluster-prod.yaml</Chip>
              </div>
            </div>
          </div>

          {/* 助手消息 */}
          <div className="message-wrap">
            <div className="message-assistant">
              <div className="assistant-meta">
                <span style={{ fontWeight: 700, color: 'var(--state-running)', fontSize: '12px' }}>AgOS Core Agent</span>
                <span>·</span>
                <span className="u-num">耗时 4.2s</span>
                <span>·</span>
                <Chip variant="purple">Swarm Orchestrator</Chip>
              </div>

              <ReasoningBlock duration="3.4s" tokens="1,420 tokens">
                1. 分析了 <code>auth_matrix.go</code> 中的令牌刷新锁机制，发现并发更新时存在 18ms 的时间窗未加分布式互斥锁。<br />
                2. 规划 8 节点并发 Swarm 编队 (#BATCH-8402)，分别派遣给独立的特化子代理进行 Fuzzing 和故障演练。<br />
                3. 检测到最终步骤涉及 <code>/etc/agos/secrets.env</code> 写入，触发特权审批拦截策略。
              </ReasoningBlock>

              <div style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'var(--text-primary)' }}>
                已为您编排 8 节点并发审计编队 <strong>#BATCH-8402</strong>。在启动 Swarm 前，已在本地隔离容器中通过基础单元测试，以下为测试回执与代码补丁：
              </div>

              <TerminalCard
                title="bash_exec: cargo test --package auth-matrix --lib"
                command="cargo test --package auth-matrix --lib"
                output={`running 18 tests\ntest token::tests::test_jwt_signature_verify ... ok\ntest token::tests::test_refresh_token_rotation ... ok\ntest matrix::tests::test_acl_permission_grant ... ok\ntest session::tests::test_store_concurrency ... ok\ntest result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.18s`}
                duration="1.2s"
                exitCode={0}
              />

              <DiffCard
                filePath="pkg/auth/token_rotator.rs"
                stats="+4 / -2 行"
                lines={[
                  { type: 'ctx', lineNo: 42, content: '    let current_token = self.store.get_token(session_id).await?;' },
                  { type: 'del', lineNo: 43, content: '    if current_token.is_expired() {' },
                  { type: 'del', lineNo: 44, content: '        return self.issue_new_token(session_id).await;' },
                  { type: 'add', lineNo: 43, content: '    // 加分布式互斥租约，消除 18ms 并发竞争窗' },
                  { type: 'add', lineNo: 44, content: '    let _lease = self.lock_manager.acquire_lease(session_id, Duration::from_millis(500)).await?;' },
                  { type: 'add', lineNo: 45, content: '    if current_token.is_expired() {' },
                  { type: 'add', lineNo: 46, content: '        return self.issue_new_token_atomic(session_id, _lease).await;' },
                  { type: 'ctx', lineNo: 47, content: '    }' },
                ]}
              />

              <SwarmBatchCard
                batchId="BATCH-8402"
                title="8 节点并发安全巡检与契约回归"
                completedCount={5}
                totalCount={8}
                isRunning={true}
                civStats={{
                  passed: '7/8',
                  vetoed: 1,
                  gateState: '⚠️ 阻塞 (等待特权授权)',
                }}
                rows={[
                  { idx: '01', name: 'auth-crypto-auditor', role: '🎭⤴ 审计', provider: 'Claude-3.5', time: '1.2s', state: 'done', stateLabel: '已完成' },
                  { idx: '02', name: 'token-replay-verifier', role: '🎭⛓ 重放', provider: 'Qwen-2.5', time: '2.4s', state: 'done', stateLabel: '已完成' },
                  { idx: '03', name: 'session-store-race-check', role: '🎭⤴ 竞争', provider: 'DeepSeek', time: '3.1s', state: 'done', stateLabel: '已完成' },
                  { idx: '04', name: 'event-mux-benchmark', role: '🎭 基准', provider: 'Local-7B', time: '4.5s', state: 'done', stateLabel: '已完成' },
                  { idx: '05', name: 'jwt-leak-fuzzer', role: '🎭⤴ 模糊', provider: 'Claude-3.5', time: '5.2s', state: 'done', stateLabel: '已完成' },
                  { idx: '06', name: 'redis-cluster-failover', role: '🎭⛓ 演练', provider: 'DeepSeek', time: '12.8s', state: 'running', stateLabel: '处理中' },
                  { idx: '07', name: 'tls-handshake-loadtest', role: '🎭 压测', provider: 'Qwen-2.5', time: '--', state: 'queued', stateLabel: '等待中' },
                  { idx: '08', name: 'sandbox-escape-probe', role: '🎭⛓ 探针', provider: 'DeepSeek', time: '8.9s', state: 'failed', stateLabel: '未成功' },
                ]}
              />

              <ApprovalPanel
                title="特权操作审批请求: 写入受保护生产配置"
                riskLevel="LEVEL 4 · 高风险"
                actionSummary="write_to_file -> /etc/agos/secrets.env"
                diffSnippet={[
                  '+ AGOS_AUTH_MUTEX_LEASE_MS=500',
                  '+ AGOS_REDIS_FAILOVER_CLUSTER_NODES="10.0.4.11:6379,10.0.4.12:6379"',
                ]}
              />

              {/* 流式指示器 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  marginTop: '6px',
                  padding: '10px 14px',
                  backgroundColor: 'var(--bg-layer-2)',
                  borderRadius: '8px',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div className="stream-live-indicator">
                  <Dot state="running" />
                  <span style={{ fontWeight: 600 }}>正在汇聚 Redis Failover 遥测探针与内核阻断日志...</span>
                  <span className="stream-cursor" />
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                    74.2 tok/s · 18.4s
                  </span>
                  <Button variant="danger" size="sm" style={{ height: '22px', padding: '0 8px' }}>
                    中止
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 底部指令底座 */}
        <CommandDeck onSend={(msg) => console.log('Send prompt:', msg)} />
      </main>
    </div>
  );
};
