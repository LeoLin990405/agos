import React from 'react';
import { useTheme } from '@/design-system/theme-context';
import './app-rail-grammar.css';

export type MainTab = 'chat' | 'console' | 'graph' | 'settings';

/**
 * 新会话请求事件:rail 拿不到 ChatPage 内部的 isNewSessionOpen 回调,
 * 通过 window CustomEvent 解耦;由 ChatPage 监听后打开 NewSessionModal。
 */
export const NEW_SESSION_EVENT = 'agos:new-session';

export interface AppRailProps {
  currentTab: MainTab;
  onSelectTab: (tab: MainTab) => void;
  unreadCount?: number;
}

/**
 * G5 侧栏语法:动词置顶(新会话)→ 主导航(对话/控制台/记忆星图)→ 底部账号区。
 * 谱系不是 App.tsx 顶层路由(位于控制台内部),故不入主导航;
 * live.ts 无余额/身份数据源,底部账号区仅渲染设置入口。
 */
export const AppRail: React.FC<AppRailProps> = ({
  currentTab,
  onSelectTab,
  unreadCount = 0,
}) => {
  const { theme, toggleTheme } = useTheme();

  const handleNewSession = () => {
    // 新会话属于对话域:先切到对话页,再广播打开新建弹窗
    onSelectTab('chat');
    window.dispatchEvent(new CustomEvent(NEW_SESSION_EVENT));
  };

  return (
    <aside className="app-rail">
      <div className="app-rail-logo" title="AgOS 遥测甲板" onClick={() => onSelectTab('chat')}>
        AG
      </div>

      {/* ── 动词置顶:新会话 ─────────────────────────────── */}
      <div className="rail-verb-group">
        <button
          type="button"
          className="rail-btn rail-new-session"
          title="新会话 (⌘K)"
          aria-label="新会话"
          onClick={handleNewSession}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <span className="rail-kbd-chip" aria-hidden="true">⌘K</span>
      </div>

      <div className="rail-divider" role="presentation" />

      {/* ── 主导航:对话 → 控制台 → 记忆星图 ─────────────── */}
      <button
        type="button"
        className={`rail-btn ${currentTab === 'chat' ? 'is-active' : ''}`}
        title="对话流 (Chat)"
        onClick={() => onSelectTab('chat')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {unreadCount > 0 && <span className="rail-badge rail-badge--running">{unreadCount}</span>}
      </button>

      <button
        type="button"
        className={`rail-btn ${currentTab === 'console' ? 'is-active' : ''}`}
        title="控制台 (Console - 概览·机器·会话·谱系·计划·技能)"
        onClick={() => onSelectTab('console')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="3" y="3" width="7" height="9" />
          <rect x="14" y="3" width="7" height="5" />
          <rect x="14" y="12" width="7" height="9" />
          <rect x="3" y="16" width="7" height="5" />
        </svg>
      </button>

      <button
        type="button"
        className={`rail-btn ${currentTab === 'graph' ? 'is-active' : ''}`}
        title="记忆星图 (Memory Graph)"
        onClick={() => onSelectTab('graph')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      </button>

      <div className="rail-spacer" />

      {/* ── 底部账号区:主题切换 + 设置入口(无真实余额数据,不渲染 Balance) ── */}
      <div className="rail-account">
        <button
          type="button"
          className="rail-btn"
          onClick={toggleTheme}
          title="切换深浅主题"
        >
          {theme === 'dark' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          )}
        </button>

        <div className="rail-divider" role="presentation" />

        <button
          type="button"
          className={`rail-btn ${currentTab === 'settings' ? 'is-active' : ''}`}
          title="系统设置 (Settings - 特权面)"
          onClick={() => onSelectTab('settings')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </aside>
  );
};
