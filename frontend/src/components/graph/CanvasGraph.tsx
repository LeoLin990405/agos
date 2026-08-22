import React, { useRef, useEffect } from 'react';
import type { MemoryNodeData, MemoryEdgeData } from './mock-graph-data';
import type { MemoryNodeType } from '@/design-system/tokens';

interface SimNode extends MemoryNodeData {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isRecent: boolean;
}

const TYPE_COLOR_VARS: Record<MemoryNodeType, string> = {
  user: '--mem-user',
  feedback: '--mem-feedback',
  project: '--mem-project',
  reference: '--mem-reference',
  incident: '--mem-incident',
};

function graphTypeColor(type: MemoryNodeType): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(TYPE_COLOR_VARS[type]).trim();
  return raw !== '' ? raw : 'rgb(103, 158, 254)';
}

function phase01(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--u-phase').trim();
  const delay = Number.parseFloat(raw);
  if (!Number.isFinite(delay)) return (performance.now() % 2400) / 2400;
  return (((delay % 2400) + 2400) % 2400) / 2400;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const NO_MATCHED_NODES: ReadonlySet<string> = new Set();

export interface CanvasGraphProps {
  nodes: MemoryNodeData[];
  edges: MemoryEdgeData[];
  selectedNodeId?: string;
  searchQuery?: string;
  matchedNodeIds?: ReadonlySet<string>;
  typeFilter?: string;
  isSimulating?: boolean;
  onSelectNode: (node: MemoryNodeData | null) => void;
  onHoverNode: (node: MemoryNodeData | null) => void;
}

export const CanvasGraph: React.FC<CanvasGraphProps> = ({
  nodes: rawNodes,
  edges: rawEdges,
  selectedNodeId,
  searchQuery = '',
  matchedNodeIds = NO_MATCHED_NODES,
  typeFilter = 'all',
  isSimulating = true,
  onSelectNode,
  onHoverNode,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simNodesRef = useRef<SimNode[]>([]);
  const transformRef = useRef<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });
  const hoveredNodeRef = useRef<SimNode | null>(null);
  const draggingNodeRef = useRef<SimNode | null>(null);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const kickLoopRef = useRef<() => void>(() => {});

  // 初始化物理仿真节点
  useEffect(() => {
    const width = 1000;
    const height = 700;
    const now = Date.now();
    const SEVEN_DAYS = 7 * 86400000;

    simNodesRef.current = rawNodes.map((n, i) => {
      const angle = (i / rawNodes.length) * Math.PI * 2;
      const dist = 220 + Math.random() * 520; // 大幅铺开:428 节点需要空间(Obsidian 的"星空"来自留白)
      return {
        ...n,
        x: width / 2 + Math.cos(angle) * dist + (Math.random() - 0.5) * 50,
        y: height / 2 + Math.sin(angle) * dist + (Math.random() - 0.5) * 50,
        vx: 0,
        vy: 0,
        radius: Math.max(2.6, Math.min(9, 2.6 + Math.sqrt(n.outDegree) * 1.7)), // Obsidian 星点:小而密,sqrt 缩放
        isRecent: now - n.mtime < SEVEN_DAYS,
      };
    });
  }, [rawNodes]);

  // 首帧自动取景(一次):包围盒适配画布,留 12% 边距
  const autofitDoneRef = React.useRef(false);
  useEffect(() => { autofitDoneRef.current = false; }, [rawNodes]);

  // 动画与物理主循环
  useEffect(() => {
    let animId = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let warmup = 0;
    let alpha = 1;          // 模拟退火:热度衰减到 0.02 后冻结(Obsidian 的"落定即静止")
    let appearT = 0;        // 载入淡入 0→1
    let focusT = 0;         // 焦点过渡 0→1(hover/选中平滑,不瞬跳)

    const tick = () => {
      const simNodes = simNodesRef.current;
      const width = canvas.width / (window.devicePixelRatio || 1);
      const height = canvas.height / (window.devicePixelRatio || 1);

      // 1. 物理计算 (力导向,带退火:落定后完全静止)
      if (isSimulating && alpha > 0.02) {
        alpha *= 0.9965;
        // 库仑斥力
        for (let i = 0; i < simNodes.length; i++) {
          const a = simNodes[i];
          for (let j = i + 1; j < simNodes.length; j++) {
            const b = simNodes[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distSq = dx * dx + dy * dy + 100;
            const dist = Math.sqrt(distSq);
            if (dist < 560) {
              const force = 620 / distSq; // 400+ 节点需要更强斥力才能出星座感
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              a.vx -= fx;
              a.vy -= fy;
              b.vx += fx;
              b.vy += fy;
            }
          }
        }

        // 弹簧引力
        const nodeMap = new Map<string, SimNode>();
        simNodes.forEach((n) => nodeMap.set(n.id, n));

        rawEdges.forEach((edge) => {
          const source = nodeMap.get(edge.from);
          const target = nodeMap.get(edge.to);
          if (source && target) {
            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const targetDist = edge.dangling ? 200 : 130;
            const force = (dist - targetDist) * 0.006;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            source.vx += fx;
            source.vy += fy;
            target.vx -= fx;
            target.vy -= fy;
          }
        });

        // 向心引力与速度阻尼
        const cx = width / 2;
        const cy = height / 2;
        simNodes.forEach((n) => {
          if (n !== draggingNodeRef.current) {
            n.vx += (cx - n.x) * 0.00022;
            n.vy += (cy - n.y) * 0.00022;
            n.x += n.vx * alpha;
            n.y += n.vy * alpha;
            n.vx *= 0.88;
            n.vy *= 0.88;
          }
        });
      }

      // 预热 60 帧后做一次自动取景(等物理摊开)
      warmup += 1;
      if (!autofitDoneRef.current && warmup === 60 && simNodes.length > 0) {
        autofitDoneRef.current = true;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        simNodes.forEach((n) => { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
        const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        const vw = canvas.width / (window.devicePixelRatio || 1), vh = canvas.height / (window.devicePixelRatio || 1);
        const fit = Math.min(vw / bw, vh / bh) * 0.88;
        const k2 = Math.max(0.25, Math.min(1.1, fit));
        transformRef.current = { k: k2, x: vw / 2 - (minX + bw / 2) * k2, y: vh / 2 - (minY + bh / 2) * k2 };
      }

      // 2. 渲染画布
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const dpr = window.devicePixelRatio || 1;
      const { x: tx, y: ty, k } = transformRef.current;
      ctx.scale(dpr, dpr);
      ctx.translate(tx, ty);
      ctx.scale(k, k);

      appearT = Math.min(1, appearT + 0.03);
      const focusTarget = (hoveredNodeRef.current || selectedNodeId) ? 1 : 0;
      focusT += (focusTarget - focusT) * 0.16; // ~150ms 平滑,Obsidian 的渐隐邻域

      // 计算高亮邻域
      const hovered = hoveredNodeRef.current;
      const selectedId = selectedNodeId;
      const activeId = hovered?.id || selectedId;
      const connectedSet = new Set<string>();

      if (activeId) {
        connectedSet.add(activeId);
        rawEdges.forEach((e) => {
          if (e.from === activeId) connectedSet.add(e.to);
          if (e.to === activeId) connectedSet.add(e.from);
        });
      }

      const nodeMap = new Map<string, SimNode>();
      simNodes.forEach((n) => nodeMap.set(n.id, n));

      // 绘制边 (Edges)
      rawEdges.forEach((edge) => {
        const src = nodeMap.get(edge.from);
        const tgt = nodeMap.get(edge.to);
        if (!src) return;
        if (typeFilter !== 'all' && (src.type !== typeFilter || (tgt !== undefined && tgt.type !== typeFilter))) return;

        const isHighlighted = activeId
          ? (edge.from === activeId || edge.to === activeId)
          : false;
        const isDimmed = activeId ? !isHighlighted : false;

        let endX: number;
        let endY: number;
        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        if (tgt) {
          const dx = tgt.x - src.x;
          const dy = tgt.y - src.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          endX = tgt.x - (dx / distance) * (tgt.radius + 2);
          endY = tgt.y - (dy / distance) * (tgt.radius + 2);
          ctx.lineTo(endX, endY);
        } else {
          // 悬挂边向外发散示意
          const angle = (parseInt(src.id.replace(/\D/g, '') || '1', 10) % 8) * (Math.PI / 4);
          endX = src.x + Math.cos(angle) * 45;
          endY = src.y + Math.sin(angle) * 45;
          ctx.lineTo(endX, endY);
        }

        if (edge.kind === 'supersedes') {
          ctx.setLineDash([8, 3]);
          ctx.strokeStyle = isHighlighted
            ? 'rgba(239, 143, 143, 0.92)'
            : isDimmed
              ? 'rgba(239, 143, 143, 0.12)'
              : `rgba(239, 143, 143, ${0.44 * appearT})`;
          ctx.lineWidth = isHighlighted ? 2 : 1.25;
        } else if (edge.dangling) {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = isHighlighted
            ? '#f59e0b'
            : isDimmed
            ? 'rgba(245, 158, 11, 0.12)'
            : 'rgba(200, 200, 210, 0.14)'; /* dangling:暗虚线,不喊叫 */
          ctx.lineWidth = isHighlighted ? 1.8 : 1;
        } else {
          ctx.setLineDash([]);
          const edgeDim = isDimmed ? focusT : 0;
          ctx.strokeStyle = (activeId && isHighlighted)
            ? `rgba(103, 158, 254, ${0.3 + 0.55 * focusT})`
            : `rgba(255, 255, 255, ${(0.10 - 0.075 * edgeDim) * appearT})`;
          ctx.lineWidth = isHighlighted ? 1.4 : 0.7;
        }
        ctx.stroke();

        // Supersedes is a directed invalidation relation. Its arrowhead points
        // from the current record to the record it replaces.
        if (edge.kind === 'supersedes') {
          ctx.setLineDash([]);
          const angle = Math.atan2(endY - src.y, endX - src.x);
          const arrowSize = isHighlighted ? 7 : 5;
          ctx.beginPath();
          ctx.moveTo(endX, endY);
          ctx.lineTo(
            endX - Math.cos(angle - Math.PI / 6) * arrowSize,
            endY - Math.sin(angle - Math.PI / 6) * arrowSize,
          );
          ctx.moveTo(endX, endY);
          ctx.lineTo(
            endX - Math.cos(angle + Math.PI / 6) * arrowSize,
            endY - Math.sin(angle + Math.PI / 6) * arrowSize,
          );
          ctx.stroke();
        }
      });
      ctx.setLineDash([]);

      // 绘制节点 (Nodes)
      const reducedMotion = prefersReducedMotion();
      const physicsHot = isSimulating && alpha > 0.02;
      const pulseScale = reducedMotion || !physicsHot
        ? 1
        : 1 + Math.sin(phase01() * Math.PI * 2) * 0.2;
      const runningStroke = getComputedStyle(document.documentElement).getPropertyValue('--state-running').trim();
      const doneStroke = getComputedStyle(document.documentElement).getPropertyValue('--state-done').trim();

      simNodes.forEach((node) => {
        // 类型过滤
        if (typeFilter !== 'all' && node.type !== typeFilter) return;

        const hasSearch = searchQuery.trim() !== '';
        const isMatchSearch = !hasSearch || matchedNodeIds.has(node.id);

        const isDimmed = activeId
          ? !connectedSet.has(node.id)
          : hasSearch && !isMatchSearch;

        const color = graphTypeColor(node.type);
        // 标签和白环必须用显式焦点；无焦点时全图开灯会造成视觉噪声。
        const isFocus = activeId ? connectedSet.has(node.id) : false;
        const radius = node.radius * (isFocus ? 1.25 : 1);

        // 最近7天更新节点挂载共息呼吸光晕
        if (node.isRecent && !isDimmed) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, radius * 1.8 * pulseScale, 0, Math.PI * 2);
          ctx.fillStyle = `${color}22`;
          ctx.fill();
        }

        // 节点本体
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        const dimMix = isDimmed ? focusT : 0; // 0=正常 1=完全沉底
        ctx.globalAlpha = appearT * (1 - dimMix * 0.85);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = appearT;
        if (isFocus) { // 只有焦点邻域上细环,平时无描边(Obsidian 语法)
          ctx.lineWidth = node.id === selectedId ? 2 : 1.4;
          ctx.strokeStyle = node.id === selectedId
            ? (runningStroke || color)
            : 'rgba(255, 255, 255, 0.8)';
          ctx.stroke();
        } else if (hasSearch && isMatchSearch) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = doneStroke || 'rgba(127, 206, 155, 0.95)';
          ctx.stroke();
        }

        // 标签文本 (高亮节点或出度大节点显示)
        if ((isFocus || (hasSearch && isMatchSearch) || k > 1.5) && !isDimmed) { // Obsidian:标签只给焦点邻域或明显放大后
          ctx.fillStyle = (isFocus || (hasSearch && isMatchSearch)) ? 'rgba(255,255,255,0.92)' : 'rgba(255, 255, 255, 0.45)';
          ctx.font = `${(isFocus || (hasSearch && isMatchSearch)) ? '600 ' : ''}9.5px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(node.id, node.x, node.y + radius + 12);
        }
      });

      ctx.restore();
      const interacting = draggingNodeRef.current !== null || isPanningRef.current;
      const settling = appearT < 1 || Math.abs(focusTarget - focusT) > 0.02;
      if (physicsHot || interacting || settling) {
        animId = requestAnimationFrame(tick);
      }
    };

    const schedule = () => {
      cancelAnimationFrame(animId);
      animId = requestAnimationFrame(tick);
    };
    kickLoopRef.current = schedule;
    schedule();
    return () => {
      cancelAnimationFrame(animId);
      kickLoopRef.current = () => {};
    };
  }, [isSimulating, matchedNodeIds, rawEdges, selectedNodeId, searchQuery, typeFilter]);

  // 自适应 Canvas 尺寸
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas || !canvas.parentElement) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      kickLoopRef.current();
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 鼠标交互 (Hover / Drag / Zoom / Pan)
  const getSimNodeAtPos = (clientX: number, clientY: number): SimNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const { x: tx, y: ty, k } = transformRef.current;
    const x = (clientX - rect.left - tx) / k;
    const y = (clientY - rect.top - ty) / k;

    const simNodes = simNodesRef.current;
    for (let i = simNodes.length - 1; i >= 0; i--) {
      const n = simNodes[i];
      if (typeFilter !== 'all' && n.type !== typeFilter) continue;
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) {
        return n;
      }
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    kickLoopRef.current();
    if (draggingNodeRef.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const { x: tx, y: ty, k } = transformRef.current;
      draggingNodeRef.current.x = (e.clientX - rect.left - tx) / k;
      draggingNodeRef.current.y = (e.clientY - rect.top - ty) / k;
      return;
    }

    if (isPanningRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      transformRef.current.x += dx;
      transformRef.current.y += dy;
      panStartRef.current = { x: e.clientX, y: e.clientY };
      return;
    }

    const hit = getSimNodeAtPos(e.clientX, e.clientY);
    if (hit !== hoveredNodeRef.current) {
      hoveredNodeRef.current = hit;
      onHoverNode(hit);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    kickLoopRef.current();
    const hit = getSimNodeAtPos(e.clientX, e.clientY);
    if (hit) {
      draggingNodeRef.current = hit;
      onSelectNode(hit);
    } else {
      isPanningRef.current = true;
      panStartRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = () => {
    draggingNodeRef.current = null;
    isPanningRef.current = false;
  };

  const handleMouseLeave = () => {
    handleMouseUp();
    hoveredNodeRef.current = null;
    onHoverNode(null);
    kickLoopRef.current();
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    kickLoopRef.current();
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const { x, y, k } = transformRef.current;
    const newK = Math.max(0.3, Math.min(4, k * zoomFactor));

    transformRef.current = {
      x: mouseX - (mouseX - x) * (newK / k),
      y: mouseY - (mouseY - y) * (newK / k),
      k: newK,
    };
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onSelectNode(null);
      return;
    }
    const visibleNodes = simNodesRef.current.filter((node) => {
      if (typeFilter !== 'all' && node.type !== typeFilter) return false;
      return searchQuery.trim() === '' || matchedNodeIds.has(node.id);
    });
    if (visibleNodes.length === 0) return;
    const currentIndex = visibleNodes.findIndex((node) => node.id === selectedNodeId);
    let nextIndex: number | undefined;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = visibleNodes.length - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % visibleNodes.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? visibleNodes.length - 1 : (currentIndex - 1 + visibleNodes.length) % visibleNodes.length;
    if (nextIndex === undefined) return;
    event.preventDefault();
    onSelectNode(visibleNodes[nextIndex] ?? null);
  };

  const selectedAccessibleNode = rawNodes.find((node) => node.id === selectedNodeId);

  return (
    <div className="graph-canvas-container">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        role="application"
        aria-roledescription="交互式记忆图谱"
        aria-label={`记忆图谱，共 ${rawNodes.length} 个节点。使用方向键浏览，Home 或 End 跳转，Escape 清除选择。`}
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      >
        当前浏览器不支持 Canvas 记忆图谱。
      </canvas>
      <span
        aria-live="polite"
        style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}
      >
        {selectedAccessibleNode ? `已选择 ${selectedAccessibleNode.id}，类型 ${selectedAccessibleNode.sourceType}` : '未选择记忆节点'}
      </span>
    </div>
  );
};
