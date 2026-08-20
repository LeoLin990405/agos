import React from 'react';
import { useTheme } from '@/design-system/theme-context';

export interface AppRailProps {
  currentTab: 'chat' | 'console' | 'lineage';
  onSelectTab: (tab: 'chat' | 'console' | 'lineage') => void;
  unreadCount?: number;
}

export const AppRail: React.FC<AppRailProps> = ({
  currentTab,
  onSelectTab,
  unreadCount = 1,
}) => {
  const { theme, toggleTheme } = useTheme();

  return (
    <aside className="app-rail">
      <div className="app-rail-logo" title="AgOS 遥测甲板" onClick={() => onSelectTab('chat')}>
        AG
      </div>

      <button
        type="button"
        className={`rail-btn ${currentTab === 'chat' ? 'is-active' : ''}`}
        title="对话流"
        onClick={() => onSelectTab('chat')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {unreadCount > 0 && <span className="rail-badge rail-badge--running">{unreadCount}</span>}
      </button>

      <button
        type="button"
        className={`rail-btn ${currentTab === 'console' ? 'is-active' : ''}`}
        title="控制台概览"
        onClick={() => onSelectTab('console')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="7" height="9" />
          <rect x="14" y="3" width="7" height="5" />
          <rect x="14" y="12" width="7" height="9" />
          <rect x="3" y="16" width="7" height="5" />
        </svg>
      </button>

      <button
        type="button"
        className={`rail-btn ${currentTab === 'lineage' ? 'is-active' : ''}`}
        title="智能体谱系"
        onClick={() => onSelectTab('lineage')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 3v12" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      </button>

      <div className="rail-spacer" />

      <button
        type="button"
        className="rail-btn"
        onClick={toggleTheme}
        title="切换深浅主题"
      >
        <span>{theme === 'dark' ? '🌙' : '☀️'}</span>
      </button>
    </aside>
  );
};
