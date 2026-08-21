import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fitMenuToViewport, type MenuPoint } from './session-menu-position';
import '@/design-system/session-menu.css';

export type { MenuPoint } from './session-menu-position';

interface MenuItem {
  key: string;
  label: string;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  onSelect: () => void;
}

export interface SessionContextMenuProps {
  point: MenuPoint;
  sessionId: string;
  cwd: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  hostArchived: boolean;
  running: boolean;
  metaAvailable: boolean;
  managementPending: boolean;
  canOpenPath: boolean;
  canUseClipboard: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onToggleArchive: () => void;
  onReveal: () => void;
  onCopy: (value: string, label: string) => void;
  onDelete: () => void;
}

export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
  point,
  sessionId,
  cwd,
  title,
  pinned,
  archived,
  hostArchived,
  running,
  metaAvailable,
  managementPending,
  canOpenPath,
  canUseClipboard,
  onClose,
  onTogglePin,
  onRename,
  onToggleArchive,
  onReveal,
  onCopy,
  onDelete,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState(point);

  const groups = useMemo<MenuItem[][]>(() => {
    const management: MenuItem[] = [];
    if (metaAvailable) {
      management.push({
        key: 'pin',
        label: pinned ? '取消置顶' : '置顶会话',
        disabled: managementPending,
        title: managementPending ? '正在同步上一项会话管理操作' : undefined,
        onSelect: onTogglePin,
      });
    }
    management.push({
      key: 'rename',
      label: '重命名会话',
      disabled: managementPending,
      title: managementPending ? '正在同步上一项会话管理操作' : undefined,
      onSelect: onRename,
    });
    if (metaAvailable) {
      management.push(hostArchived
        ? {
            key: 'archive-host',
            label: '已由宿主归档',
            disabled: true,
            title: '宿主当前没有取消归档能力；这里只读展示该状态',
            onSelect: () => undefined,
          }
        : {
            key: 'archive',
            label: archived ? '取消归档' : '归档会话',
            disabled: managementPending,
            title: managementPending ? '正在同步上一项会话管理操作' : undefined,
            onSelect: onToggleArchive,
          });
    }

    const reveal: MenuItem[] = canOpenPath && cwd !== ''
      ? [{ key: 'reveal', label: '在访达中显示', onSelect: onReveal }]
      : [];
    const copy: MenuItem[] = canUseClipboard
      ? [
          ...(cwd !== '' ? [{ key: 'copy-cwd', label: '拷贝工作目录', onSelect: () => onCopy(cwd, '工作目录') }] : []),
          { key: 'copy-id', label: '拷贝会话 ID', onSelect: () => onCopy(sessionId, '会话 ID') },
        ]
      : [];
    const deletion: MenuItem[] = metaAvailable
      ? [{
          key: 'delete',
          label: '删除会话…',
          danger: true,
          disabled: running || managementPending,
          title: running
            ? '运行中，请先中止'
            : managementPending
              ? '正在同步上一项会话管理操作'
              : `将“${title}”移入磁盘回收站目录`,
          onSelect: onDelete,
        }]
      : [];
    return [management, reveal, copy, deletion].filter((group) => group.length > 0);
  }, [archived, canOpenPath, canUseClipboard, cwd, hostArchived, managementPending, metaAvailable, onCopy, onDelete, onRename, onReveal, onToggleArchive, onTogglePin, pinned, running, sessionId, title]);

  const items = groups.flat();

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setPosition(fitMenuToViewport(point, rect, {
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }, [point]);

  useEffect(() => {
    const firstEnabled = itemRefs.current.find((item) => item !== null && item.getAttribute('aria-disabled') !== 'true');
    firstEnabled?.focus();
    const closeFromOutside = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const closeFromScroll = (): void => onClose();
    const closeFromResize = (): void => onClose();
    document.addEventListener('pointerdown', closeFromOutside);
    window.addEventListener('scroll', closeFromScroll, true);
    window.addEventListener('resize', closeFromResize);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      window.removeEventListener('scroll', closeFromScroll, true);
      window.removeEventListener('resize', closeFromResize);
    };
  }, [onClose]);

  const moveFocus = (current: HTMLButtonElement, direction: 1 | -1): void => {
    const enabled = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && item.getAttribute('aria-disabled') !== 'true');
    if (enabled.length === 0) return;
    const currentIndex = enabled.indexOf(current);
    enabled[(currentIndex + direction + enabled.length) % enabled.length]?.focus();
  };

  const menu = (
    <div
      ref={menuRef}
      className="session-context-menu"
      role="menu"
      aria-label={`会话“${title}”管理菜单`}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(event.target as HTMLButtonElement, event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const enabled = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && item.getAttribute('aria-disabled') !== 'true');
          enabled[event.key === 'Home' ? 0 : enabled.length - 1]?.focus();
        }
      }}
    >
      {groups.map((group, groupIndex) => (
        <React.Fragment key={group.map((item) => item.key).join(':')}>
          {groupIndex > 0 && <div className="session-menu-separator" role="separator" />}
          <div className="session-menu-group" role="group">
            {group.map((item) => {
              const flatIndex = items.indexOf(item);
              return (
                <button
                  key={item.key}
                  ref={(element) => { itemRefs.current[flatIndex] = element; }}
                  type="button"
                  role="menuitem"
                  aria-label={item.disabled && item.title ? `${item.label}，${item.title}` : item.label}
                  className={`session-menu-item${item.danger ? ' is-danger' : ''}`}
                  aria-disabled={item.disabled === true}
                  title={item.title}
                  onClick={() => {
                    if (item.disabled) return;
                    item.onSelect();
                    onClose();
                  }}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </React.Fragment>
      ))}
    </div>
  );

  return typeof document === 'undefined' ? null : createPortal(menu, document.body);
};
