import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { LiveTranscript } from '@/pages/chat-transcript';
import { AgosComputer } from '@/components/stage/AgosComputer';
import { ReplayScrubber } from '@/components/stage/ReplayScrubber';
import { Button } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Dot';
import type { StateLamp } from '@/design-system/tokens';
import {
  closeRemoteRun,
  openRemoteRun,
  remoteRunKey,
  remoteRunStore,
  type RemoteRunState,
} from '@/stores/live';
import {
  reconcileRemoteReplayLimit,
  remoteReplayValue,
  type RemoteReplayLimit,
} from './remote-run-view-model';
import './remote-run-view.css';

export interface RemoteRunViewProps {
  host: string;
  runId: string;
  onClose: () => void;
}

const RUN_STATUS: Record<string, { lamp: StateLamp; label: string }> = {
  queued: { lamp: 'queued', label: '等待中' },
  waking: { lamp: 'queued', label: '唤醒中' },
  running: { lamp: 'running', label: '运行中' },
  detached: { lamp: 'running', label: '连接已脱离' },
  completed: { lamp: 'done', label: '已完成' },
  failed: { lamp: 'failed', label: '未成功' },
  cancelled: { lamp: 'failed', label: '已取消' },
  interrupted: { lamp: 'failed', label: '已中断' },
  lost: { lamp: 'failed', label: '工作区已丢失' },
};

function runStatus(state: RemoteRunState): { lamp: StateLamp; label: string } {
  const explicit = state.runStatus ?? state.outcome;
  if (explicit !== undefined && RUN_STATUS[explicit] !== undefined) return RUN_STATUS[explicit];
  if (state.phase === 'loading') return { lamp: 'queued', label: '正在接入轨迹' };
  if (state.phase === 'live') return { lamp: 'running', label: '轨迹直播中' };
  if (state.phase === 'ended') return { lamp: 'done', label: '轨迹已结束' };
  if (state.phase === 'error') return { lamp: 'failed', label: '轨迹不可用' };
  return { lamp: 'queued', label: '等待接入' };
}

const RemoteRunSession: React.FC<RemoteRunViewProps> = ({ host, runId, onClose }) => {
  const key = remoteRunKey(host, runId);
  const state = useSyncExternalStore(
    remoteRunStore.subscribe,
    useCallback(() => remoteRunStore.getSnapshot(key), [key]),
  );
  const [replayLimit, setReplayLimit] = useState<RemoteReplayLimit>(undefined);

  useEffect(() => {
    openRemoteRun(host, runId);
    return () => closeRemoteRun(host, runId);
  }, [host, runId]);

  const snapshot = state.snapshot;
  const total = snapshot?.items.length ?? 0;
  const replayValue = remoteReplayValue(replayLimit, total);
  useEffect(() => {
    setReplayLimit((current) => reconcileRemoteReplayLimit(current, total));
  }, [total]);
  const status = runStatus(state);
  const hasTranscript = snapshot !== undefined
    && (snapshot.items.length > 0 || snapshot.todos.length > 0);
  const hasStaleSnapshot = state.phase === 'error' && snapshot !== undefined;

  let emptyMessage = snapshot !== undefined || state.totalLines > 0
    ? '远端轨迹已建立，尚未产生可显示的对话条目。'
    : '远端正在启动，尚未产生轨迹。';
  if (state.phase === 'idle' || state.phase === 'loading') emptyMessage = '正在接入远端轨迹…';
  else if (state.phase === 'ended') {
    emptyMessage = snapshot !== undefined || state.totalLines > 0
      ? '运行已结束，轨迹中没有可显示的对话条目。'
      : '运行已结束，但没有收到可回放的轨迹。';
  }
  else if (state.phase === 'error') emptyMessage = state.error ?? '远端轨迹暂时不可用。';

  return (
    <section className="remote-run-view" aria-labelledby="remote-run-view-title">
      <div className="remote-run-view__left">
        <header className="remote-run-view__header">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="返回 Fleet 批次">
            ← 返回批次
          </Button>
          <div className="remote-run-view__identity">
            <h2 id="remote-run-view-title">远端运行直播</h2>
            <p>
              <span>{host}</span>
              <span aria-hidden>·</span>
              <code>{runId}</code>
              {state.totalLines > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span className="u-num">轨迹 {state.totalLines} 行</span>
                </>
              )}
            </p>
          </div>
          <div className="remote-run-view__status" role="status" aria-live="polite">
            <Dot state={status.lamp} size={6} />
            <span>{status.label}</span>
          </div>
        </header>

        {hasStaleSnapshot && (
          <div className="remote-run-view__notice" role="status">
            轨迹更新已中断，当前保留已接收内容。{state.error !== undefined ? ` ${state.error}` : ''}
          </div>
        )}

        <div className="remote-run-view__transcript">
          {hasTranscript ? (
            <LiveTranscript
              sessionId={key}
              snapshotOverride={snapshot}
              readOnly
              replayLimit={replayLimit === undefined ? undefined : replayValue}
            />
          ) : (
            <div
              className={`remote-run-view__empty${state.phase === 'error' ? ' is-error' : ''}`}
              role={state.phase === 'error' ? 'alert' : 'status'}
            >
              {emptyMessage}
            </div>
          )}
        </div>

        {total > 0 && (
          <ReplayScrubber
            sessionId={`remote-${host}-${runId}`}
            total={total}
            value={replayValue}
            onChange={setReplayLimit}
            onLive={() => setReplayLimit(undefined)}
          />
        )}
      </div>

      <div className="remote-run-view__computer">
        <AgosComputer
          sessionId={undefined}
          remote={{ host, runId }}
          onClose={onClose}
        />
      </div>
    </section>
  );
};

/** key 让同一挂载点切 run 时同步丢弃上一条 run 的回放位置。 */
export const RemoteRunView: React.FC<RemoteRunViewProps> = (props) => (
  <RemoteRunSession key={remoteRunKey(props.host, props.runId)} {...props} />
);
