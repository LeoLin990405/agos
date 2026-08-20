/**
 * AgOS Design Tokens & Type System
 */

export type StateLamp = 'queued' | 'running' | 'done' | 'failed';

export interface StateDefinition {
  label: string;
  dotClass: string;
  badgeClass: string;
  colorVar: string;
}

export const STATE_DEFS: Record<StateLamp, StateDefinition> = {
  queued: {
    label: '等待中',
    dotClass: 'u-dot--queued',
    badgeClass: 'badge--queued',
    colorVar: 'var(--state-queued)',
  },
  running: {
    label: '处理中',
    dotClass: 'u-dot--running',
    badgeClass: 'badge--running',
    colorVar: 'var(--state-running)',
  },
  done: {
    label: '已完成',
    dotClass: 'u-dot--done',
    badgeClass: 'badge--done',
    colorVar: 'var(--state-done)',
  },
  failed: {
    label: '未成功',
    dotClass: 'u-dot--failed',
    badgeClass: 'badge--failed',
    colorVar: 'var(--state-failed)',
  },
};

export const MOTION_CONSTANTS = {
  PULSE_DURATION_MS: 2400, // 25 BPM
  TICK_MS: 90,
  FAST_MS: 140,
  BASE_MS: 220,
  STAGGER_MS: 24,
  MAX_STAGGER_ITEMS: 6,
} as const;
