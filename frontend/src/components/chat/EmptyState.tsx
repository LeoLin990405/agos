/**
 * EmptyState —— 新会话空态(P0-1,Kimi 基因)。
 *
 * 两个导出件,集成人把 CommandDeck 夹在中间:
 *   <EmptyStateHero />   —— AgOS 文字 logotype + 一行能力副语
 *   <CommandDeck … />
 *   <EmptyStateBelow />  —— ①能力胶囊排(真 preset + 两个导航口)②最近会话极简列表
 *
 * 数据纪律(零编造):
 * - 胶囊排的模式来自 live.ts 的 `fetchPresets()`(agentPreset.list 真值),
 *   未加载完成时整排不渲染,不占位、不塞假模式名。
 * - 最近会话来自 `sessionsStore`(session.list 轮询,已按 updatedAt 倒序),
 *   为空则整块不渲染。相对时间由本地纯函数 formatRelative 计算,不引三方库。
 * - 组件自身不做路由跳转、不订阅路由,一切出口都是外置回调。
 *
 * 样式全在 src/design-system/empty-state.css(.es-* 类),此处不写内联视觉样式;
 * 唯一的内联是 --es-i(入场级联序号,CSS 侧 calc(var(--es-i) * 24ms))。
 */
import React, { useSyncExternalStore } from 'react';
import { Dot } from '@/components/ui/Dot';
import type { StateLamp } from '@/design-system/tokens';
import type { MainTab } from '@/components/layout/AppRail';
import { fetchPresets, sessionsStore, type PresetInfo, type SessionSummaryRow } from '@/stores/live';
import '@/design-system/empty-state.css';

/** 最近会话渲染上限(与 CSS 注释里的级联上限 N=6 一致)。 */
const RECENT_LIMIT = 6;

/** 入场级联序号:写进 --es-i,由 .es-anim 折算成 animation-delay。 */
const anim = (index: number): React.CSSProperties => ({ '--es-i': index } as React.CSSProperties);

/**
 * 相对时间(纯函数,便于单测):
 * <1 分 = 刚刚 / <60 分 = N 分钟前 / <24 时 = N 小时前 / 否则 N 天前。
 * 无效时间戳(0 / NaN / 负数)返回空串,由调用方决定是否渲染。
 */
export function formatRelative(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diff = now - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// ── presets 的 external store(数据源仍是 live.ts 的 fetchPresets)──────────────
// live.ts 只暴露一次性的 fetchPresets(),没有 preset store;这里做模块级缓存 +
// 订阅壳,保证 useSyncExternalStore 语义与引用稳定,且整个应用只拉一次。
const NO_PRESETS: PresetInfo[] = [];
let presetSnapshot: PresetInfo[] = NO_PRESETS;
let presetInFlight = false;
const presetListeners = new Set<() => void>();

function loadPresetsOnce(): void {
  if (presetInFlight || presetSnapshot.length > 0) return;
  presetInFlight = true;
  void fetchPresets()
    .then((list) => {
      presetInFlight = false;
      if (list.length === 0) return; // 拉空不改快照,下次订阅仍会重试
      presetSnapshot = list;
      for (const listener of presetListeners) listener();
    })
    .catch(() => {
      presetInFlight = false; // 后端缺席:保持空态,不渲染胶囊排
    });
}

const presetsStore = {
  subscribe(listener: () => void): () => void {
    presetListeners.add(listener);
    loadPresetsOnce();
    return () => { presetListeners.delete(listener); };
  },
  getSnapshot(): PresetInfo[] { return presetSnapshot; },
};

// ── Hero ─────────────────────────────────────────────────────────────────────

/** 空态上半:AgOS 文字 logotype + 12.5px 三级色副语。无数据依赖,恒定渲染。 */
export const EmptyStateHero: React.FC = () => (
  <div className="es-hero">
    <div className="es-logotype es-anim" style={anim(0)}>AgOS</div>
    <div className="es-tagline es-anim" style={anim(1)}>本地舰队 · 多模型 · 全程可回放</div>
  </div>
);

// ── Below ────────────────────────────────────────────────────────────────────

export interface EmptyStateBelowProps {
  /** 点击原生模式胶囊:回调真实 presetId(agentPreset.list 的 id)。 */
  onSelectPreset?: (presetId: string) => void;
  /** 点击导航胶囊:回调 App.tsx 的路由 tab 名('graph' / 'console')。 */
  onNavigate?: (tab: MainTab) => void;
  /** 点击最近会话行:回调真实 sessionId。 */
  onOpenSession?: (sessionId: string) => void;
}

const GraphIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);

const ConsoleIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
    <rect x="3" y="3" width="7" height="9" />
    <rect x="14" y="3" width="7" height="5" />
    <rect x="14" y="12" width="7" height="9" />
    <rect x="3" y="16" width="7" height="5" />
  </svg>
);

/** running → 运行灯,其余 → 完成灯(与 ChatPage 会话矩阵同一映射)。 */
const rowLamp = (row: SessionSummaryRow): StateLamp => (row.running ? 'running' : 'done');

/**
 * 空态下半:能力胶囊排 + 最近会话。
 * 两块各自空态即各自不渲染;两块都空则整个组件 return null(不留空容器)。
 */
export const EmptyStateBelow: React.FC<EmptyStateBelowProps> = ({
  onSelectPreset,
  onNavigate,
  onOpenSession,
}) => {
  const presets = useSyncExternalStore(presetsStore.subscribe, presetsStore.getSnapshot);
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);

  const recent = sessions.rows.slice(0, RECENT_LIMIT);
  const hasChips = presets.length > 0;
  const hasRecent = recent.length > 0;
  if (!hasChips && !hasRecent) return null;

  // 级联序号:胶囊排整排算 1 步,「最近会话」标签 1 步,之后每行 1 步。
  const labelIndex = hasChips ? 1 : 0;

  return (
    <div className="es-below">
      {hasChips && (
        <div className="es-chip-row es-anim" style={anim(0)}>
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="es-chip"
              title={preset.description !== '' ? preset.description : preset.name}
              onClick={() => onSelectPreset?.(preset.id)}
            >
              {preset.name}
            </button>
          ))}
          <button
            type="button"
            className="es-chip"
            title="打开记忆星图"
            onClick={() => onNavigate?.('graph')}
          >
            <GraphIcon />
            记忆星图
          </button>
          <button
            type="button"
            className="es-chip"
            title="打开控制台"
            onClick={() => onNavigate?.('console')}
          >
            <ConsoleIcon />
            控制台
          </button>
        </div>
      )}

      {hasRecent && (
        <div className="es-recent">
          <div className="es-recent-label u-microlabel es-anim" style={anim(labelIndex)}>
            最近会话
          </div>
          {recent.map((row, i) => {
            const relative = formatRelative(row.updatedAt);
            return (
              <button
                key={row.sessionId}
                type="button"
                className="es-session-row es-anim"
                style={anim(labelIndex + 1 + i)}
                title={row.cwd !== '' ? row.cwd : row.title}
                onClick={() => onOpenSession?.(row.sessionId)}
              >
                <Dot state={rowLamp(row)} />
                <span className="es-session-title">{row.title}</span>
                {relative !== '' && <span className="es-session-time u-num">{relative}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
