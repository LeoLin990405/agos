import React, { useRef, useEffect, useState, useCallback } from 'react';
import { MemoryNodeData, MemoryEdgeData } from './mock-graph-data';
import { MemoryNodeType } from '@/design-system/tokens';

interface SimNode extends MemoryNodeData {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isRecent: boolean;
}

/* Obsidian 式柔和五色(降饱和;user 用 DeepSeek 蓝维持品牌) */
const TYPE_COLORS: Record<MemoryNodeType, string> = {
  user: '#679efe',
  feedback: '#7fce9b',
  project: '#b5a1ef',
  reference: '#dfb56e',
  incident: '#ef8f8f',
};

export interface CanvasGraphProps {
  nodes: MemoryNodeData[];
  edges: MemoryEdgeData[];
  selectedNodeId?: string;
  searchQuery?: string;
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
    let animId: number;
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

        const isHighlighted = activeId
          ? (edge.from === activeId || edge.to === activeId)
          : false;
        const isDimmed = activeId ? !isHighlighted : false;

        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        if (tgt) {
          ctx.lineTo(tgt.x, tgt.y);
        } else {
          // 悬挂边向外发散示意
          const angle = (parseInt(src.id.replace(/\D/g, '') || '1', 10) % 8) * (Math.PI / 4);
          ctx.lineTo(src.x + Math.cos(angle) * 45, src.y + Math.sin(angle) * 45);
        }

        if (edge.dangling) {
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
      });

      // 绘制节点 (Nodes)
      const nowMs = performance.now();
      const pulsePhase = (nowMs % 2400) / 2400; // 0..1 2400ms 同频心跳
      const pulseScale = 1 + Math.sin(pulsePhase * Math.PI * 2) * 0.2;

      simNodes.forEach((node) => {
        // 类型过滤
        if (typeFilter !== 'all' && node.type !== typeFilter) return;

        const isMatchSearch =
          !searchQuery ||
          node.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          node.id.toLowerCase().includes(searchQuery.toLowerCase());

        const isHighlighted = activeId ? connectedSet.has(node.id) : isMatchSearch;
        const isDimmed = (activeId && !connectedSet.has(node.id)) || (searchQuery && !isMatchSearch);

        const color = TYPE_COLORS[node.type] || '#679efe';
        // isHighlighted 在无焦点时对全图为真(空搜索=全命中),只能用于"防变暗";
        // 标签/白环必须用显式焦点(有 activeId 才有焦点)——否则全图开灯=乱。
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
          ctx.lineWidth = 1.4;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          ctx.stroke();
        }

        // 标签文本 (高亮节点或出度大节点显示)
        if ((isFocus || k > 1.5) && !isDimmed) { // Obsidian:标签只给焦点邻域或明显放大后
          ctx.fillStyle = isFocus ? 'rgba(255,255,255,0.92)' : 'rgba(255, 255, 255, 0.45)';
          ctx.font = `${isFocus ? '600 ' : ''}9.5px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(node.id, node.x, node.y + radius + 12);
        }
      });

      ctx.restore();
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
    // 焦点/过滤变化 → 复热一点,让图轻微再排(Obsidian 同款手感)
    return () => cancelAnimationFrame(animId);
  }, [isSimulating, rawEdges, selectedNodeId, searchQuery, typeFilter]);

  // 自适应 Canvas 尺寸
  useEffect(() => {
    const handleResize = () => {
      const canvas = canvasRef.current;
      if (!canvas || !canvas.parentElement) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
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
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) {
        return n;
      }
    }
    return null;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
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

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
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

  return (
    <div className="graph-canvas-container">
      <canvas
        ref={canvasRef}
        className="graph-canvas"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      />
    </div>
  );
};
