import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { postMemoryRelevance } from '@/components/stage/session-memory-relevance-api';
import {
  INJECT_IS_NOT_VERDICT_COPY,
  RELEVANCE_CONFIRM_COPY,
} from '@/components/stage/session-memory-rank';
import { fetchTurnEvidence } from './turn-evidence-api';
import {
  IMPRESSION_WHY_COPY,
  turnEvidenceChips,
  turnEvidenceFeedbackTargets,
  turnEvidenceImpressionLabels,
  turnEvidenceUnrecordableCopy,
  type TurnEvidence,
} from './turn-evidence';

export const TurnEvidenceStrip: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
  const [evidence, setEvidence] = useState<TurnEvidence>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = (): void => {
      void fetchTurnEvidence(sessionId).then(
        (next) => {
          if (!cancelled) {
            setEvidence(next);
            setError(undefined);
          }
        },
        (reason) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    };
    load();
    timer = setInterval(load, 4_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [sessionId]);

  useEffect(() => {
    setConfirm(false);
    setNotice(undefined);
  }, [sessionId]);

  const chips = evidence === undefined ? ['本跳证据未采集'] : turnEvidenceChips(evidence);
  const targets = evidence === undefined ? [] : turnEvidenceFeedbackTargets(evidence);
  const unrecordable = evidence === undefined ? undefined : turnEvidenceUnrecordableCopy(evidence);
  const labels = evidence === undefined ? [] : turnEvidenceImpressionLabels(evidence);
  return (
    <div className="turn-evidence" aria-label="本跳证据">
      <div className="surface-instrument" style={{ marginTop: 0 }}>
        {chips.map((copy) => (
          <Chip key={copy}>{copy}</Chip>
        ))}
        {evidence?.memory.query !== undefined && evidence.memory.query !== null && evidence.memory.query !== '' && (
          <span className="u-microlabel">问句 {evidence.memory.query}</span>
        )}
        {targets.length === 0 && labels.length > 0 && (
          <span className="u-microlabel">{labels.slice(0, 6).join(' · ')}</span>
        )}
        {evidence?.skills.served && evidence.skills.served.length > 0 && (
          <span className="u-microlabel">{evidence.skills.served.slice(0, 6).join(' · ')}</span>
        )}
        {error !== undefined && (
          <span className="surface-alert" role="alert">本跳证据未采集：{error}</span>
        )}
      </div>
      {targets.length > 0 && (
        <div className="turn-evidence-feedback">
          <span className="u-microlabel">{INJECT_IS_NOT_VERDICT_COPY}</span>
          <label className="u-microlabel">
            <input
              type="checkbox"
              checked={confirm}
              onChange={(event) => setConfirm(event.target.checked)}
            />
            {RELEVANCE_CONFIRM_COPY}
          </label>
          {targets.slice(0, 6).map((row) => (
            <div className="turn-evidence-row" key={`${row.id}:${row.text}`}>
              <span className="u-microlabel">
                {row.method === undefined
                  ? row.text
                  : `${row.text}（${IMPRESSION_WHY_COPY[row.method]}）`}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!confirm || busy || sessionId === undefined || sessionId.trim() === ''}
                onClick={() => {
                  if (sessionId === undefined || sessionId.trim() === '') return;
                  setBusy(true);
                  void postMemoryRelevance({
                    sessionId,
                    itemId: row.id,
                    result: 'ok',
                    query: evidence?.memory.query ?? undefined,
                  }).then((posted) => {
                    setBusy(false);
                    setConfirm(false);
                    setNotice(posted.ok ? `已记录 ${row.id.slice(0, 8)} / ok` : posted.error);
                  });
                }}
              >
                记有用
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!confirm || busy || sessionId === undefined || sessionId.trim() === ''}
                onClick={() => {
                  if (sessionId === undefined || sessionId.trim() === '') return;
                  setBusy(true);
                  void postMemoryRelevance({
                    sessionId,
                    itemId: row.id,
                    result: 'fail',
                    query: evidence?.memory.query ?? undefined,
                  }).then((posted) => {
                    setBusy(false);
                    setConfirm(false);
                    setNotice(posted.ok ? `已记录 ${row.id.slice(0, 8)} / fail` : posted.error);
                  });
                }}
              >
                记误召回
              </Button>
            </div>
          ))}
        </div>
      )}
      {unrecordable !== undefined && (
        <span className="u-microlabel">{unrecordable}</span>
      )}
      {notice !== undefined && (
        <span className="u-microlabel">{notice}</span>
      )}
    </div>
  );
};
