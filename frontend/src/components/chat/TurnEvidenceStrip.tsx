import React, { useEffect, useRef, useState } from 'react';
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
  turnEvidenceId,
  turnEvidenceImpressionLabels,
  turnEvidenceUnrecordableCopy,
  type TurnEvidence,
  type TurnEvidenceId,
} from './turn-evidence';

export interface TurnEvidenceStripProps {
  sessionId?: string;
  turn?: TurnEvidenceId | null;
  step?: TurnEvidenceId | null;
}

export const TurnEvidenceStrip: React.FC<TurnEvidenceStripProps> = ({ sessionId, turn, step }) => {
  const id = sessionId?.trim() ?? '';
  const turnId = turnEvidenceId(turn);
  const stepId = turnEvidenceId(step);
  if (id === '' || turnId === null || stepId === null) {
    return <div className="turn-evidence" aria-label="本跳证据"><Chip>本跳编号未采集</Chip></div>;
  }
  // A new binding gets new state immediately, before effects can run: previous
  // evidence and its feedback controls must never render under the new session.
  return <BoundTurnEvidenceStrip key={JSON.stringify([id, turnId, stepId])} sessionId={id} turn={turnId} step={stepId} />;
};

const BoundTurnEvidenceStrip: React.FC<{ sessionId: string; turn: string; step: string }> = ({ sessionId, turn, step }) => {
  const [evidence, setEvidence] = useState<TurnEvidence>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchTurnEvidence(sessionId, controller.signal, { turn, step });
        if (!cancelled) {
          setEvidence(next);
          setError(undefined);
        }
      } catch (reason) {
        if (!cancelled) {
          setEvidence(undefined);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        // Schedule after settlement so slower reads cannot overwrite newer reads.
        if (!cancelled) timer = setTimeout(() => { void load(); }, 4_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      mounted.current = false;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [sessionId, turn, step]);

  useEffect(() => {
    setConfirm(false);
    setNotice(undefined);
  }, [evidence?.at]);

  const recordFeedback = async (itemId: string, result: 'ok' | 'fail'): Promise<void> => {
    if (!confirm || busy || evidence === undefined || !evidence.observed) return;
    setBusy(true);
    try {
      const posted = await postMemoryRelevance({ sessionId, itemId, result, query: evidence.memory.query ?? undefined });
      if (mounted.current) setNotice(posted.ok ? `已记录 ${itemId.slice(0, 8)} / ${result}` : posted.error);
    } catch (reason) {
      if (mounted.current) setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) {
        setBusy(false);
        setConfirm(false);
      }
    }
  };

  const chips = evidence === undefined ? ['本跳证据未采集'] : turnEvidenceChips(evidence);
  const targets = evidence?.observed === true ? turnEvidenceFeedbackTargets(evidence) : [];
  const unrecordable = evidence === undefined ? undefined : turnEvidenceUnrecordableCopy(evidence);
  const labels = evidence === undefined ? [] : turnEvidenceImpressionLabels(evidence);
  return (
    <div className="turn-evidence" aria-label="本跳证据">
      <div className="surface-instrument" style={{ marginTop: 0 }}>
        <span className="u-microlabel">轮次 {turn} · 步骤 {step}</span>
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
        {evidence?.observed === true && evidence.persisted === false && (
          <span className="u-microlabel">本跳证据未持久化{evidence.persistError === null ? '' : `：${evidence.persistError}`}</span>
        )}
        {evidence?.observed === true && evidence.persisted === null && (
          <span className="u-microlabel">本跳证据持久化状态未采集</span>
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
                disabled={!confirm || busy}
                onClick={() => { void recordFeedback(row.id, 'ok'); }}
              >
                记有用
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!confirm || busy}
                onClick={() => { void recordFeedback(row.id, 'fail'); }}
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
