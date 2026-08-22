export type { MemoryIntent } from './memory-workspace-model';
export { consumeMemoryIntent, memoryIntent, resolveWorkingSessionId } from './memory-workspace-model';

export interface FleetConsoleEntry {
  tab: 'fleet';
  fleetBatchId?: string;
}

/** Preserve the exact batch id selected in the dock; omit only an absent id. */
export function fleetConsoleEntry(batchId?: string): FleetConsoleEntry {
  return batchId === undefined ? { tab: 'fleet' } : { tab: 'fleet', fleetBatchId: batchId };
}

export type SkillsConsoleTab = 'catalog' | 'audit' | 'studio';

export interface SkillsConsoleEntry {
  tab: 'skills';
  skillsTab?: SkillsConsoleTab;
  skill?: string;
}

export function skillsConsoleEntry(input?: {
  skillsTab?: SkillsConsoleTab;
  skill?: string;
}): SkillsConsoleEntry {
  const entry: SkillsConsoleEntry = { tab: 'skills' };
  if (input?.skillsTab) entry.skillsTab = input.skillsTab;
  if (typeof input?.skill === 'string' && input.skill.trim() !== '') {
    entry.skill = input.skill.trim();
  }
  return entry;
}

export function studioConsoleEntry(skill?: string): SkillsConsoleEntry {
  return skillsConsoleEntry({
    skillsTab: 'studio',
    ...(typeof skill === 'string' && skill.trim() !== '' ? { skill: skill.trim() } : {}),
  });
}

export function routesConsoleEntry(): { tab: 'routes' } {
  return { tab: 'routes' };
}
