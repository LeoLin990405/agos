import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Button, ButtonProps } from '@/components/ui/Button';
import { useTheme } from '@/design-system/theme-context';

/* ==========================================================================
   顶栏动作按钮:响应式收敛的唯一载体
   同时渲染 14px 图标与文字标签,由 layout.css 的容器查询在顶栏 < 1200px 时
   把文字收掉、按钮塌成方形图标键;aria-label / title 始终保留完整中文名。
   纯 CSS 收敛,不做任何 JS 宽度测量。
   ========================================================================== */

export interface TopbarActionProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** 完整中文名。既是可见文字,也是收窄后的 aria-label / title。 */
  label: string;
  /** 14px 图标(收窄后唯一可见的内容),建议用下面的 TOPBAR_ICONS。 */
  icon: React.ReactNode;
  variant?: ButtonProps['variant'];
  /** false = 永不收成图标(主动作用)。默认 true。 */
  collapsible?: boolean;
}

export const TopbarAction: React.FC<TopbarActionProps> = ({
  label,
  icon,
  variant = 'ghost',
  collapsible = true,
  className = '',
  title,
  ...props
}) => (
  <Button
    variant={variant}
    size="sm"
    className={`topbar-action${collapsible ? ' is-collapsible' : ''} ${className}`}
    title={title ?? label}
    aria-label={label}
    {...props}
  >
    <span className="topbar-action-icon" aria-hidden="true">{icon}</span>
    <span className="topbar-action-label">{label}</span>
  </Button>
);

const svgProps = {
  viewBox: '0 0 16 16',
  width: 14,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

/** 顶栏自带的 14px 线性图标,零依赖内联 SVG。 */
export const TOPBAR_ICONS = {
  /** 记忆星图 / 图谱 */
  graph: (
    <svg {...svgProps}>
      <circle cx="3.5" cy="4" r="1.7" />
      <circle cx="12.5" cy="3.2" r="1.4" />
      <circle cx="8.2" cy="9.4" r="1.9" />
      <circle cx="3" cy="12.6" r="1.3" />
      <path d="M4.9 5.1 6.9 8.1M9.9 8.4 11.6 4.5M6.8 10.7 4 11.6" />
    </svg>
  ),
  /** 控制台 / 概览 */
  console: (
    <svg {...svgProps}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M2 6.2h12M5 9.2h6M5 11.2h3.5" />
    </svg>
  ),
  /** 深色模式 */
  moon: (
    <svg {...svgProps}>
      <path d="M13.2 9.7A5.6 5.6 0 0 1 6.3 2.8a5.6 5.6 0 1 0 6.9 6.9Z" />
    </svg>
  ),
  /** 浅色模式 */
  sun: (
    <svg {...svgProps}>
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1.6v1.5M8 12.9v1.5M14.4 8h-1.5M3.1 8H1.6M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1" />
    </svg>
  ),
} as const;

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
  runningState = false,
}) => {
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="app-topbar">
      <div className="topbar-left">
        {runningState && <Dot state="running" />}
        <div className="topbar-title-wrap">
          <h1 className="topbar-title" title={title}>{title}</h1>
          {badge}
        </div>
      </div>

      <div className="topbar-right">
        {rightActions}
        <TopbarAction
          label={theme === 'dark' ? '深色模式' : '浅色模式'}
          icon={theme === 'dark' ? TOPBAR_ICONS.moon : TOPBAR_ICONS.sun}
          title="切换深浅模式"
          onClick={toggleTheme}
        />
      </div>
    </header>
  );
};
