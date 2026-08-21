export const MAX_ARTIFACT_COUNT = 2_000;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface ArtifactManifestLimits {
  count: number;
  totalBytes: number;
  truncated: boolean;
  tooLarge?: boolean;
}

export interface ArtifactBundleGuard {
  allowed: boolean;
  reason: string | undefined;
}

/**
 * The archive route streams bytes, but it still refuses sets whose complete
 * size cannot be proven safe. Keep this decision pure so the disabled UI and
 * the server's 413 boundary cannot silently drift apart.
 */
export function artifactBundleGuard(manifest: ArtifactManifestLimits): ArtifactBundleGuard {
  if (manifest.tooLarge === true) {
    return { allowed: false, reason: '服务端已判定产物集过大，请逐个下载需要的文件。' };
  }
  if (manifest.truncated) {
    return { allowed: false, reason: '清单已截断，无法确认完整规模，已禁用打包下载。' };
  }
  if (manifest.count > MAX_ARTIFACT_COUNT) {
    return { allowed: false, reason: `文件超过 ${MAX_ARTIFACT_COUNT} 个，请逐个下载需要的文件。` };
  }
  if (manifest.totalBytes > MAX_ARTIFACT_BYTES) {
    return { allowed: false, reason: '产物总量超过 512 MiB，请逐个下载需要的文件。' };
  }
  return { allowed: true, reason: undefined };
}

export function formatArtifactBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}
