/**
 * AgOS Design Tokens & Type System V2
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

export type MemoryNodeType = 'user' | 'feedback' | 'project' | 'reference' | 'incident';

export interface MemoryNodeMeta {
  label: string;
  color: string;
  colorBg: string;
}

export const MEMORY_TYPE_DEFS: Record<MemoryNodeType, MemoryNodeMeta> = {
  user: {
    label: '用户偏好 / User',
    color: 'var(--mem-user)',
    colorBg: 'var(--mem-user-bg)',
  },
  feedback: {
    label: '经验反馈 / Feedback',
    color: 'var(--mem-feedback)',
    colorBg: 'var(--mem-feedback-bg)',
  },
  project: {
    label: '架构项目 / Project',
    color: 'var(--mem-project)',
    colorBg: 'var(--mem-project-bg)',
  },
  reference: {
    label: '契约参考 / Ref',
    color: 'var(--mem-reference)',
    colorBg: 'var(--mem-reference-bg)',
  },
  incident: {
    label: '故障复盘 / Incident',
    color: 'var(--mem-incident)',
    colorBg: 'var(--mem-incident-bg)',
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
