import { MemoryNodeType } from '@/design-system/tokens';

export interface MemoryNodeData {
  id: string;
  type: MemoryNodeType;
  title: string;
  description: string;
  bytes: number;
  mtime: number; // timestamp
  outDegree: number;
  wikilinks: string[];
}

export interface MemoryEdgeData {
  from: string;
  to: string;
  dangling?: boolean;
}

export interface MemoryGraphData {
  nodes: MemoryNodeData[];
  edges: MemoryEdgeData[];
  counts: Record<MemoryNodeType, number>;
}

// 构造 120+ 篇真实感的知识图谱节点
export function generateMockMemoryGraph(): MemoryGraphData {
  const now = Date.now();
  const DAY_MS = 86400000;

  const rawNodes: Omit<MemoryNodeData, 'outDegree'>[] = [
    // 1. User 偏好与指令 (24 nodes)
    { id: 'user-leo-brief-standards', type: 'user', title: 'Leo 的 UI 审美与工程纪律', description: '拒绝廉价 AI Slop 模板；强制 Geist 排印、等宽数字、四态激光灯语与 2400ms 全局共息心跳。', bytes: 1420, mtime: now - 1 * DAY_MS, wikilinks: ['proj-agos-telemetry-deck', 'ref-sym-respiration-spec', 'incident-v1-too-plain'] },
    { id: 'user-reduced-motion-policy', type: 'user', title: '无障碍与动效降级白名单', description: '严禁除 transform/opacity 外的重排动画；prefers-reduced-motion 下强制停止一切循环扫描。', bytes: 890, mtime: now - 3 * DAY_MS, wikilinks: ['ref-web-design-guidelines', 'proj-agos-telemetry-deck'] },
    { id: 'user-chinese-typography-rules', type: 'user', title: '中文无衬线排印行高规范', description: '字距微调 -0.01em，行高 1.55-1.6，标点悬挂与代码符号光学对齐。', bytes: 1120, mtime: now - 5 * DAY_MS, wikilinks: ['ref-geist-font-spec', 'user-leo-brief-standards'] },
    { id: 'user-force-graph-expectations', type: 'user', title: '星图级 Graph Engineering 预期', description: '120+ 篇记忆用 Canvas 纯手写力导向图呈现，悬浮单跳高亮，虚线代表待写悬挂边。', bytes: 960, mtime: now - 0.5 * DAY_MS, wikilinks: ['proj-memory-graph-engine', 'dangling-openalex-sync'] },
    { id: 'user-security-clearance-levels', type: 'user', title: 'Level 4 特权审批防御策略', description: '涉及 /etc 与受保护系统变量的修改必须触发人机阻断审批面板，支持单次/永久信任。', bytes: 1300, mtime: now - 2 * DAY_MS, wikilinks: ['proj-seccomp-sandbox', 'ref-dsh-rpc-contract'] },
    { id: 'user-dark-mode-first', type: 'user', title: '曜石航电深色优先原则', description: '默认深色 Obsidian Avionics，浅色为工程 Spec 图纸；材质海拔与镜面高光分层。', bytes: 1040, mtime: now - 4 * DAY_MS, wikilinks: ['ref-design-tokens-v2', 'user-leo-brief-standards'] },

    // 2. Project 项目与架构 (36 nodes)
    { id: 'proj-agos-telemetry-deck', type: 'project', title: 'AgOS 遥测甲板 SPA (agos-frontend)', description: 'dsh 自有 SPA 前端，采用 Vite + React 18 + TS，完全映射 55 项后端 RPC 与插件路由。', bytes: 4800, mtime: now - 0.2 * DAY_MS, wikilinks: ['ref-dsh-rpc-contract', 'ref-sym-respiration-spec', 'proj-memory-graph-engine', 'proj-swarm-orchestration'] },
    { id: 'proj-memory-graph-engine', type: 'project', title: 'Canvas 记忆图谱渲染引擎', description: '基于 HTML5 Canvas 的高性能力模拟算法，支持弹性引力、库仑斥力与速度阻尼。', bytes: 3200, mtime: now - 0.1 * DAY_MS, wikilinks: ['ref-canvas-physics-math', 'user-force-graph-expectations'] },
    { id: 'proj-swarm-orchestration', type: 'project', title: '8 节点并发 Swarm 编队协议', description: '协调主调度器与子代理的任务分发、状态聚合及 CivStrip 治理晋升门。', bytes: 3900, mtime: now - 1.5 * DAY_MS, wikilinks: ['ref-civ-governance-rules', 'incident-subagent-escape-e4012'] },
    { id: 'proj-seccomp-sandbox', type: 'project', title: 'Linux 内核 Seccomp 隔离网关', description: '沙箱环境对宿主命名空间、调试接口与内核设备的系统调用拦截守护进程。', bytes: 2900, mtime: now - 6 * DAY_MS, wikilinks: ['incident-subagent-escape-e4012', 'user-security-clearance-levels'] },
    { id: 'proj-ws-426-mux-stream', type: 'project', title: 'WebSocket 426 多路复用全双工管道', description: '流先行长连接架构，支持 session/subscribed、projection 与事件帧并发反压分发。', bytes: 3100, mtime: now - 2 * DAY_MS, wikilinks: ['ref-dsh-rpc-contract', 'proj-agos-telemetry-deck'] },
    { id: 'proj-dataconnect-postgres', type: 'project', title: 'PostgreSQL 模式定义与迁移引擎', description: '基于 SQL Connect 的关系表架构与自动化向后兼容校验。', bytes: 2450, mtime: now - 12 * DAY_MS, wikilinks: ['ref-dsh-rpc-contract', 'feedback-migration-zero-downtime'] },

    // 3. Feedback 反馈与工程沉淀 (30 nodes)
    { id: 'feedback-sym-lock-precision', type: 'feedback', title: '2400ms 锁相同步解决闪烁疲劳', description: '实测发现如果各组件独立跑 requestAnimationFrame 呼吸会导致视觉混乱，统一注入 --u-phase 彻底平抑了眼部疲劳。', bytes: 1650, mtime: now - 1 * DAY_MS, wikilinks: ['ref-sym-respiration-spec', 'proj-agos-telemetry-deck'] },
    { id: 'feedback-attention-inbox-restraint', type: 'feedback', title: '借鉴 Codex priorityThreads 的克制设计', description: '没有待处理项时保持宁静，有错误或阻断时以三阶红/黄/蓝高光置顶推进。', bytes: 1420, mtime: now - 3 * DAY_MS, wikilinks: ['proj-agos-telemetry-deck', 'user-leo-brief-standards'] },
    { id: 'feedback-migration-zero-downtime', type: 'feedback', title: '平滑零停机契约热替换经验', description: '在保持 P0 契约二进制不动的前提下，通过注入 Shims 实现平滑替换上游前端。', bytes: 1890, mtime: now - 14 * DAY_MS, wikilinks: ['proj-dataconnect-postgres', 'ref-dsh-rpc-contract'] },
    { id: 'feedback-input-required-claude-state', type: 'feedback', title: '提问面板独立态人机等待体验', description: '在需要用户抉择时，将对话流收敛为单选/多选卡片，避免命令行交互的冰冷感。', bytes: 1200, mtime: now - 2 * DAY_MS, wikilinks: ['user-leo-brief-standards', 'proj-agos-telemetry-deck'] },

    // 4. Reference 契约与规范 (25 nodes)
    { id: 'ref-dsh-rpc-contract', type: 'reference', title: 'DSH 55 方法 RPC 协议契约', description: '涵盖 session/subagent/approval/question/goal/host 全生命周期 Zod 契约集合。', bytes: 6400, mtime: now - 20 * DAY_MS, wikilinks: ['proj-agos-telemetry-deck', 'proj-ws-426-mux-stream'] },
    { id: 'ref-sym-respiration-spec', type: 'reference', title: '共息呼吸动效工程白皮书 (25 BPM)', description: '定义 2.4 秒单一时间相位基准与虚拟时间戳注入公式 -(now % 2400)ms。', bytes: 2100, mtime: now - 4 * DAY_MS, wikilinks: ['proj-agos-telemetry-deck', 'feedback-sym-lock-precision'] },
    { id: 'ref-civ-governance-rules', type: 'reference', title: 'Civ 多智能体政体与投票准则', description: '定义多数决、否决权与安全晋升门的自动化判定矩阵。', bytes: 2800, mtime: now - 8 * DAY_MS, wikilinks: ['proj-swarm-orchestration', 'incident-subagent-escape-e4012'] },
    { id: 'ref-geist-font-spec', type: 'reference', title: 'Geist & Geist Mono 工业字体规范', description: '高精度等宽字符间距与 tabular-nums 符号渲染指导。', bytes: 1540, mtime: now - 15 * DAY_MS, wikilinks: ['user-chinese-typography-rules', 'ref-design-tokens-v2'] },
    { id: 'ref-design-tokens-v2', type: 'reference', title: 'AgOS Tokens V2 变量体系', description: '定义 Obsidian Avionics 深色与 Spec 浅色双主题的 CSS 变量及海拔阴影。', bytes: 3400, mtime: now - 0.3 * DAY_MS, wikilinks: ['proj-agos-telemetry-deck', 'user-dark-mode-first'] },
    { id: 'ref-canvas-physics-math', type: 'reference', title: '力导向图物理仿真微分方程', description: '包含 Hooke 弹簧定律、Coulomb 反比平方斥力与 Verlet 速度积分公式。', bytes: 2300, mtime: now - 5 * DAY_MS, wikilinks: ['proj-memory-graph-engine'] },

    // 5. Incident 故障复盘与漏洞记录 (20 nodes)
    { id: 'incident-v1-too-plain', type: 'incident', title: 'INC-20260820-01: V1 原型质感不足复盘', description: '执行怯懦导致数据少时空旷无物，缺乏材质深度与排印锚点；已通过 Geist 字体与镜面高光彻底修正。', bytes: 2100, mtime: now - 1 * DAY_MS, wikilinks: ['user-leo-brief-standards', 'ref-design-tokens-v2'] },
    { id: 'incident-subagent-escape-e4012', type: 'incident', title: 'INC-20260819-04: 子代理越界探针被截获', description: '探针尝试挂载 /sys/kernel/debug 触发 E4012 策略阻断，验证了 Seccomp 隔离层的可靠性。', bytes: 3100, mtime: now - 2.5 * DAY_MS, wikilinks: ['proj-seccomp-sandbox', 'user-security-clearance-levels'] },
    { id: 'incident-redis-failover-race', type: 'incident', title: 'INC-20260818-02: 哨兵切换期间令牌竞争', description: '18ms 互斥锁时间窗导致偶发令牌刷新重放，已通过分布式租约补丁修复。', bytes: 2750, mtime: now - 7 * DAY_MS, wikilinks: ['proj-swarm-orchestration', 'feedback-migration-zero-downtime'] },
  ];

  // 扩展生成更多节点使总数达到 124 个
  const types: MemoryNodeType[] = ['user', 'feedback', 'project', 'reference', 'incident'];
  for (let i = 1; i <= 100; i++) {
    const type = types[i % types.length];
    const daysAgo = (i * 1.3) % 28;
    const nodeId = `${type}-spec-node-${String(i).padStart(3, '0')}`;
    const targetA = rawNodes[i % rawNodes.length].id;
    const targetB = i % 5 === 0 ? `dangling-hook-${i}` : rawNodes[(i * 3) % rawNodes.length].id;

    rawNodes.push({
      id: nodeId,
      type,
      title: `${type.toUpperCase()} 沉淀条目 #${String(i).padStart(3, '0')}`,
      description: `关于 ${type} 维度的深度工程沉淀，与 ${targetA} 形成了稳定的依赖拓扑与双链验证。`,
      bytes: 800 + ((i * 137) % 2400),
      mtime: now - daysAgo * DAY_MS,
      wikilinks: [targetA, targetB],
    });
  }

  // 构建边与出度
  const edges: MemoryEdgeData[] = [];
  const nodeMap = new Map<string, number>();

  rawNodes.forEach((n) => {
    nodeMap.set(n.id, 0);
  });

  rawNodes.forEach((n) => {
    n.wikilinks.forEach((target) => {
      const isDangling = !nodeMap.has(target);
      edges.push({
        from: n.id,
        to: target,
        dangling: isDangling,
      });
      nodeMap.set(n.id, (nodeMap.get(n.id) || 0) + 1);
    });
  });

  const nodes: MemoryNodeData[] = rawNodes.map((n) => ({
    ...n,
    outDegree: nodeMap.get(n.id) || 1,
  }));

  const counts: Record<MemoryNodeType, number> = {
    user: 0,
    feedback: 0,
    project: 0,
    reference: 0,
    incident: 0,
  };

  nodes.forEach((n) => {
    counts[n.type] = (counts[n.type] || 0) + 1;
  });

  return { nodes, edges, counts };
}
