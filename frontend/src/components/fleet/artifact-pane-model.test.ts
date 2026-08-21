import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_COUNT,
  artifactBundleGuard,
  formatArtifactBytes,
} from './artifact-pane-model';
import { fleetArtifactDownloadUrl } from '@/lib/fleet-origin';

test('artifact bundle guard accepts a complete manifest at both limits', () => {
  assert.deepEqual(artifactBundleGuard({
    count: MAX_ARTIFACT_COUNT,
    totalBytes: MAX_ARTIFACT_BYTES,
    truncated: false,
  }), { allowed: true, reason: undefined });
});

test('artifact bundle guard fails closed for truncated, server-too-large, count and byte limits', () => {
  const cases = [
    { manifest: { count: 1, totalBytes: 1, truncated: true }, match: /截断/ },
    { manifest: { count: 1, totalBytes: 1, truncated: false, tooLarge: true }, match: /服务端/ },
    { manifest: { count: MAX_ARTIFACT_COUNT + 1, totalBytes: 1, truncated: false }, match: /2000/ },
    { manifest: { count: 1, totalBytes: MAX_ARTIFACT_BYTES + 1, truncated: false }, match: /512 MiB/ },
  ];
  for (const { manifest, match } of cases) {
    const guard = artifactBundleGuard(manifest);
    assert.equal(guard.allowed, false);
    assert.match(guard.reason ?? '', match);
  }
});

test('formatArtifactBytes stays honest for known and invalid sizes', () => {
  assert.equal(formatArtifactBytes(0), '0 B');
  assert.equal(formatArtifactBytes(1536), '1.5 KiB');
  assert.equal(formatArtifactBytes(5 * 1024 * 1024), '5.0 MiB');
  assert.equal(formatArtifactBytes(Number.NaN), '大小未知');
});

test('artifact links encode every query value and never request trace inclusion', () => {
  const fileUrl = fleetArtifactDownloadUrl(
    'file',
    'worker 甲',
    'r-1',
    'reports/a+b 中.md',
    { dev: false },
  );
  assert.match(fileUrl, /host=worker\+%E7%94%B2/);
  assert.match(fileUrl, /path=reports%2Fa%2Bb\+%E4%B8%AD\.md/);
  const parsed = new URL(fileUrl, 'http://agos.local');
  assert.equal(parsed.searchParams.get('host'), 'worker 甲');
  assert.equal(parsed.searchParams.get('path'), 'reports/a+b 中.md');
  assert.equal(parsed.searchParams.has('include'), false);

  const tgzUrl = fleetArtifactDownloadUrl('tgz', 'worker', 'r-1', undefined, { dev: false });
  assert.equal(new URL(tgzUrl, 'http://agos.local').searchParams.has('include'), false);
});
