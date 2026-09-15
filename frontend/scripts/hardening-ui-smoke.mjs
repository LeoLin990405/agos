// Real browser / synthetic data. Store+transport race tests live in src/stores.
// Uses an installed Playwright and browser; never downloads or installs them.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = await import(process.env.AGOS_PLAYWRIGHT_MODULE || 'playwright');
const cacheDir = await mkdtemp(path.join(tmpdir(), 'agos-browser-cache-'));
let server;
let browser;
const checks = [];
try {
  server = await createServer({
    configFile: false, root, cacheDir, base: '/', plugins: [react()],
    resolve: { alias: { '@': path.join(root, 'src') } },
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AGOS_BROWSER_EXECUTABLE ? { executablePath: process.env.AGOS_BROWSER_EXECUTABLE } : {}),
  });
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/scripts/hardening-ui-fixture.html`);
  const panel = page.locator('[data-approval-phase]');
  await panel.waitFor();
  await page.getByRole('button', { name: '允许单次执行', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-approval-phase]')?.getAttribute('data-approval-phase') === 'pending');
  assert.equal(await page.getByRole('button', { name: '允许单次执行', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__hardening.approvals), 1);
  assert.ok(!(await panel.innerText()).includes('已放行'));
  checks.push('click waits, prevents duplicate submission, and does not claim authorization');
  await page.evaluate(() => window.__hardening.setPhase('accepted'));
  await page.waitForFunction(() => document.querySelector('[data-approval-phase]')?.getAttribute('data-approval-phase') === 'accepted');
  assert.ok(!(await panel.innerText()).includes('已放行'));
  checks.push('accepted HTTP state still waits for host evidence');
  await page.evaluate(() => window.__hardening.setPhase('error'));
  await page.getByText('合成网络失败，请重试', { exact: true }).waitFor();
  await page.getByRole('button', { name: '允许单次执行', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__hardening.approvals), 2);
  await page.evaluate(() => window.__hardening.setPhase('resolved'));
  await page.getByText('已放行:本次特权执行已授权', { exact: false }).waitFor();
  checks.push('failed approval retries and resolved evidence renders terminal state');
  await page.evaluate(() => { window.__hardening.setPhase('idle'); window.__hardening.setReadOnly(true); });
  await page.getByText('远端审批暂不可答', { exact: false }).waitFor();
  assert.equal(await page.getByRole('button', { name: '允许单次执行', exact: true }).isDisabled(), true);
  checks.push('remote read-only approval stays disabled');
  await page.getByRole('button', { name: '加载更早的历史', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '加载更早的历史', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.__hardening.setHistory({ incomplete: true, retryable: true, loading: false }));
  await page.getByRole('button', { name: '重试', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__hardening.pages), 2);
  checks.push('incomplete history remains visible; failed page can retry');
  if (process.env.AGOS_UI_SCREENSHOT) {
    await mkdir(path.dirname(process.env.AGOS_UI_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.AGOS_UI_SCREENSHOT, fullPage: true });
  }
  await page.evaluate(() => window.__hardening.setHistory({ incomplete: false, retryable: false, loading: false }));
  await page.waitForFunction(() => document.querySelector('[data-history-incomplete]') === null);
  checks.push('completed history removes incomplete banner');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, browser: browser.version(), scope: 'real browser component fixture; no production host' }, null, 2));
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.close();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }
}
