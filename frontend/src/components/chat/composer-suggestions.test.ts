import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(here, rel), 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

test('composer does not invent a host suggestion channel', () => {
  const deck = readSrc('CommandDeck.tsx');
  const chat = readSrc('../../pages/ChatPage.tsx');
  const live = readSrc('../../stores/live.ts');
  const code = stripComments([deck, chat, live].join('\n'));

  assert.match(deck, /Do not locally invent ghost overlay/);
  assert.match(deck, /<textarea/);
  assert.match(chat, /<CommandDeck /);
  assert.match(live, /agos\.call\('session\/prompt'/);

  assert.doesNotMatch(code, /建议/);
  assert.doesNotMatch(code, /ghost[- ]?text|ghostText|ghostOverlay|ghost-overlay/);
  assert.doesNotMatch(code, /typeahead|autocomplete|aria-autocomplete|completer/i);
  assert.doesNotMatch(code, /session\/(?:complete|suggest)/);
  assert.doesNotMatch(code, /['"`]\/(?:api\/)?(?:complete|suggest)(?:['"`?/]|$)/);
});
