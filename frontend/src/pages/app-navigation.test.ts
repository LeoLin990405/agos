import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fleetConsoleEntry,
  memoryIntent,
  routesConsoleEntry,
  skillsConsoleEntry,
  studioConsoleEntry,
} from './app-navigation';

test('fleet dock navigation preserves the selected batch deep link', () => {
  assert.deepEqual(fleetConsoleEntry('b-real-007'), {
    tab: 'fleet',
    fleetBatchId: 'b-real-007',
  });
  assert.deepEqual(fleetConsoleEntry(), { tab: 'fleet' });
});

test('skills console entry opens the skills tab without inventing a batch', () => {
  assert.deepEqual(skillsConsoleEntry(), { tab: 'skills' });
  assert.deepEqual(skillsConsoleEntry({ skillsTab: 'audit' }), { tab: 'skills', skillsTab: 'audit' });
});

test('studio and routes entries do not invent a skill or a batch', () => {
  assert.deepEqual(studioConsoleEntry(), { tab: 'skills', skillsTab: 'studio' });
  assert.deepEqual(studioConsoleEntry(' inbox-triage '), {
    tab: 'skills',
    skillsTab: 'studio',
    skill: 'inbox-triage',
  });
  assert.deepEqual(studioConsoleEntry('   '), { tab: 'skills', skillsTab: 'studio' });
  assert.deepEqual(routesConsoleEntry(), { tab: 'routes' });
});

test('memoryIntent is a one-shot desk jump and does not invent ids', () => {
  assert.deepEqual(memoryIntent(), {});
  assert.deepEqual(memoryIntent({ sessionId: 'session-1' }), { sessionId: 'session-1' });
});
