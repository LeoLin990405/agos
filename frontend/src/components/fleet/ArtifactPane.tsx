import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import {
  fetchFleetArtifacts,
  type FleetArtifactFile,
  type FleetArtifactsManifest,
} from '@/stores/live';
import { fleetArtifactDownloadUrl } from '@/lib/fleet-origin';
import { artifactBundleGuard, formatArtifactBytes } from './artifact-pane-model';
import './artifact-pane.css';

type ArtifactLoadState =
  | { key: string; phase: 'loading'; manifest: undefined; error: undefined }
  | { key: string; phase: 'ready'; manifest: FleetArtifactsManifest; error: undefined }
  | { key: string; phase: 'error'; manifest: undefined; error: string };

function artifactErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '产物清单暂时不可用。';
}

function artifactMtime(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}

const ArtifactRow: React.FC<{
  file: FleetArtifactFile;
  host: string;
  runId: string;
}> = ({ file, host, runId }) => {
  const mtime = artifactMtime(file.mtime);
  return (
    <li className="artifact-row">
      <div className="artifact-row-main">
        <div className="artifact-path" title={file.path}>{file.path}</div>
        <div className="artifact-meta">
          <span className="u-num">{formatArtifactBytes(file.size)}</span>
          {mtime !== undefined && <span>{mtime}</span>}
          {file.binary && <Chip>二进制</Chip>}
        </div>
      </div>
      <a
        className="btn btn-sm btn-ghost artifact-download"
        href={fleetArtifactDownloadUrl('file', host, runId, file.path)}
        download
      >
        下载
      </a>
    </li>
  );
};

export const ArtifactPane: React.FC<{ host: string; runId: string }> = ({ host, runId }) => {
  const [reload, setReload] = useState(0);
  const requestKey = `${host}\0${runId}`;
  const [state, setState] = useState<ArtifactLoadState>({
    key: requestKey,
    phase: 'loading',
    manifest: undefined,
    error: undefined,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ key: requestKey, phase: 'loading', manifest: undefined, error: undefined });
    void fetchFleetArtifacts(host, runId, controller.signal).then(
      (manifest) => {
        if (!controller.signal.aborted) {
          setState({ key: requestKey, phase: 'ready', manifest, error: undefined });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ key: requestKey, phase: 'error', manifest: undefined, error: artifactErrorMessage(error) });
        }
      },
    );
    return () => controller.abort();
  }, [host, reload, requestKey, runId]);

  const guard = useMemo(
    () => state.manifest === undefined ? undefined : artifactBundleGuard(state.manifest),
    [state.manifest],
  );

  if (state.key !== requestKey || state.phase === 'loading') {
    return <p className="artifact-state" aria-live="polite">正在读取远端产物清单…</p>;
  }

  if (state.phase === 'error') {
    return (
      <div className="artifact-state artifact-state-error" role="alert">
        <p>{state.error}</p>
        <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>重试</Button>
      </div>
    );
  }

  const { manifest } = state;
  return (
    <div className="artifact-pane">
      <div className="artifact-summary">
        <div>
          <strong className="u-num">{manifest.count}</strong> 个文件
          <span aria-hidden> · </span>
          <span className="u-num">{formatArtifactBytes(manifest.totalBytes)}</span>
        </div>
        <div className="artifact-actions">
          <Button size="sm" variant="ghost" onClick={() => setReload((value) => value + 1)}>刷新</Button>
          {guard?.allowed === true ? (
            <a
              className="btn btn-sm artifact-bundle"
              href={fleetArtifactDownloadUrl('tgz', host, runId)}
              download={`${host}-${runId}.tgz`}
            >
              打包下载
            </a>
          ) : (
            <button className="btn btn-sm artifact-bundle" type="button" disabled title={guard?.reason}>
              打包下载
            </button>
          )}
        </div>
      </div>

      <p className="artifact-note">运行轨迹暂不可打包下载；下载后请对照清单核验文件数。</p>
      {guard?.reason !== undefined && <p className="artifact-limit" role="status">{guard.reason}</p>}

      {manifest.files.length === 0 ? (
        <p className="artifact-state">远端工作区还没有可回传的产物。</p>
      ) : (
        <ul className="artifact-list">
          {manifest.files.map((file) => (
            <ArtifactRow file={file} host={host} runId={runId} key={file.path} />
          ))}
        </ul>
      )}
    </div>
  );
};
