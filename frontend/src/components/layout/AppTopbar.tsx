import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { useTheme } from '@/design-system/theme-context';

export interface AppTopbarProps {
  title: string;
  badge?: React.ReactNode;
  rightActions?: React.ReactNode;
  runningState?: boolean;
}

export const AppTopbar: React.FC<AppTopbarProps> = ({
  title,
  badge,
  rightActions,
  runningState = true,
}) => {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="app-topbar">
      <div className="topbar-left">
        {runningState && <Dot state="running" />}
        <div className="topbar-title-wrap">
          <h1 className="topbar-title">{title}</h1>
          {badge}
        </div>
      </div>

      <div className="topbar-right">
        {rightActions}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={toggleTheme}
          title="切换深浅模式"
        >
          <span>{theme === 'dark' ? '🌙 深色模式' : '☀️ 浅色模式'}</span>
        </button>
      </div>
    </header>
  );
};
