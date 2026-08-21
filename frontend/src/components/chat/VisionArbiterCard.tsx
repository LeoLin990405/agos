import React, { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { Dot } from '@/components/ui/Dot';
import {
  DEFAULT_VISION_PANEL,
  type ArbitratedVisionResponse,
  type VisionPanelEntry,
} from './vision-arbiter-api';
import { countDivergentLines, markDivergentLines } from './vision-diff';

export type VisionArbiterCardState = 'running' | 'done' | 'failed' | 'cancelled';

export interface VisionArbiterCardProps {
  /** Original client-side filename; the server-sanitized name is in result.name. */
  imageName: string;
  state: VisionArbiterCardState;
  result?: ArbitratedVisionResponse;
  /** Useful for rendering the panel included in a non-2xx VisionRequestError. */
  panel?: readonly VisionPanelEntry[];
  error?: string;
  notice?: string;
  question?: string;
  defaultExpanded?: boolean;
  onCancel?: () => void;
  onClose?: () => void;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function providerVariant(provider: string): 'default' | 'purple' | 'amber' {
  if (provider === 'stepfun' || provider === 'mimo') return 'purple';
  if (provider === 'doubao' || provider === 'minimax') return 'amber';
  return 'default';
}

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-layer-2)',
  border: '1px solid var(--border-subtle)',
  borderRadius: '12px',
  boxShadow: 'var(--shadow-card)',
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

export const VisionArbiterCard: React.FC<VisionArbiterCardProps> = ({
  imageName,
  state,
  result,
  panel,
  error,
  notice,
  question,
  defaultExpanded = false,
  onCancel,
  onClose,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const conclusionId = useId();
  const entries = result?.panel ?? panel ?? [];
  /* W4 分歧视图:三家答案逐行对照(纯前端,零模型),不到半数家持有的行高亮。 */
  const markedPanels = useMemo(
    () => markDivergentLines(entries.map((entry) => (entry.ok ? entry.text : undefined))),
    [entries],
  );
  const divergentTotal = useMemo(() => countDivergentLines(markedPanels), [markedPanels]);
  const placeholders = entries.length === 0 && state === 'running'
    ? DEFAULT_VISION_PANEL.map((provider) => ({ provider }))
    : [];
  const lamp = state === 'running' ? 'running' : state === 'done' ? 'done' : 'failed';
  const stateLabel = state === 'running'
    ? '交叉读图中'
    : state === 'done'
    ? '仲裁完成'
    : state === 'cancelled'
    ? '已取消'
    : '读图失败';

  return (
    <section style={cardStyle} aria-label={`交叉读图: ${imageName}`} aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px', minWidth: 0 }}>
          <span style={{ paddingTop: '4px' }}><Dot state={lamp} /></span>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
              <strong style={{ color: 'var(--text-primary)', fontSize: '13px' }}>交叉读图</strong>
              <Chip active={state === 'running'} variant={state === 'failed' ? 'red' : 'default'}>
                {stateLabel}
              </Chip>
              {divergentTotal > 0 && <Chip variant="amber">面板分歧 {divergentTotal} 行</Chip>}
              {result && <span className="u-num" style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>{formatMs(result.ms)}</span>}
            </div>
            <div
              title={imageName}
              style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {imageName}{question ? ` · ${question}` : ''}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flex: 'none' }}>
          {state === 'running' && onCancel && (
            <Button variant="danger" size="sm" onClick={onCancel}>停止读图</Button>
          )}
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭交叉读图卡片">关闭</Button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '7px' }}>
        {placeholders.map((entry, index) => (
          <div key={entry.provider} style={{ border: '1px solid var(--border-dim)', borderRadius: '8px', padding: '9px 10px', backgroundColor: 'var(--bg-layer-1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <Dot state="running" size={6} />
                <span className="u-microlabel">匿名描述 {index + 1}</span>
              </span>
              <Chip active variant={providerVariant(entry.provider)}>{entry.provider}</Chip>
            </div>
            <div style={{ color: 'var(--text-tertiary)', fontSize: '11px', marginTop: '7px' }}>独立读图中…</div>
          </div>
        ))}

        {entries.map((entry, index) => {
          const flagged = result?.flagged.includes(entry.provider) ?? false;
          return (
            <div
              key={`${entry.provider}-${index}`}
              style={{
                border: `1px solid ${entry.ok ? 'var(--border-dim)' : 'var(--state-failed-border)'}`,
                borderRadius: '8px',
                padding: '9px 10px',
                backgroundColor: entry.ok ? 'var(--bg-layer-1)' : 'var(--state-failed-bg)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <Dot state={entry.ok ? 'done' : 'failed'} size={6} />
                  <span className="u-microlabel">匿名描述 {index + 1}</span>
                </span>
                <Chip variant={providerVariant(entry.provider)}>{entry.provider}</Chip>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '7px', color: entry.ok ? 'var(--text-tertiary)' : 'var(--state-failed)', fontSize: '11px' }}>
                <span className="u-num">{formatMs(entry.ms)}</span>
                <span>{entry.ok ? '已返回' : '失败'}</span>
                {flagged && <Chip variant="red">仲裁标记</Chip>}
              </div>
              {!entry.ok && entry.error && (
                <div style={{ color: 'var(--state-failed)', fontSize: '11px', lineHeight: 1.45, marginTop: '6px', overflowWrap: 'anywhere' }}>
                  {entry.error}
                </div>
              )}
              {entry.ok && entry.text && (
                <details style={{ marginTop: '7px' }}>
                  <summary style={{ color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: '11px' }}>
                    展开该家全文
                    {(markedPanels[index] ?? []).some((line) => line.divergent) && (
                      <span style={{ color: 'var(--accent-amber)' }}>
                        {` · 分歧 ${(markedPanels[index] ?? []).filter((line) => line.divergent).length} 行`}
                      </span>
                    )}
                  </summary>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '11.5px', lineHeight: 1.55, marginTop: '6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {(markedPanels[index] ?? []).map((line, lineIndex) => (
                      <div
                        key={lineIndex}
                        style={line.divergent ? {
                          // impeccable 绝对禁项:>1px 的彩色左右边框(side-stripe)。改用低透明度全边框
                          // + 背景色调,视觉权重相当但不触禁(2026-08-21 验收)。
                          border: '1px solid color-mix(in oklch, var(--accent-amber) 34%, transparent)',
                          background: 'color-mix(in oklch, var(--accent-amber) 9%, transparent)',
                          padding: '0 6px',
                          borderRadius: '3px',
                        } : undefined}
                      >
                        {line.text === '' ? ' ' : line.text}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        })}
      </div>

      {state === 'running' && (
        <div style={{ color: 'var(--text-tertiary)', fontSize: '11.5px' }}>
          三家视觉后端彼此隔离描述，完成后由第四家看图盲评仲裁。
        </div>
      )}

      {(state === 'failed' || state === 'cancelled') && (
        <div
          role={state === 'failed' ? 'alert' : undefined}
          style={{
            color: state === 'failed' ? 'var(--state-failed)' : 'var(--text-secondary)',
            backgroundColor: state === 'failed' ? 'var(--state-failed-bg)' : 'var(--bg-layer-1)',
            border: `1px solid ${state === 'failed' ? 'var(--state-failed-border)' : 'var(--border-dim)'}`,
            borderRadius: '8px',
            padding: '9px 11px',
            fontSize: '12px',
          }}
        >
          {error || (state === 'cancelled' ? '本次交叉读图已停止。' : '视觉后端未返回可用结果。')}
        </div>
      )}

      {state === 'done' && !result && notice && (
        <div style={{ color: 'var(--text-secondary)', backgroundColor: 'var(--bg-layer-1)', border: '1px solid var(--border-dim)', borderRadius: '8px', padding: '9px 11px', fontSize: '12px' }}>
          {notice}
        </div>
      )}

      {result && (
        <div
          style={{
            border: '1px solid var(--state-running-border)',
            borderLeft: '3px solid var(--state-running)',
            borderRadius: '9px',
            backgroundColor: 'var(--state-running-bg)',
            boxShadow: '0 0 0 2px var(--state-running-bg)',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '9px 11px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--state-running)', fontSize: '12px', fontWeight: 700 }}>仲裁结论</span>
              <Chip active>{result.arbiter}</Chip>
              {result.inconclusive && <Chip variant="amber">证据不足</Chip>}
              {!result.parsedOk && !result.inconclusive && <Chip variant="amber">非结构化返回</Chip>}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              aria-controls={conclusionId}
            >
              {expanded ? '折叠全文' : '展开全文'}
            </Button>
          </div>

          <div id={conclusionId} style={{ borderTop: '1px solid var(--state-running-border)', padding: '10px 11px' }}>
            <div
              style={expanded
                ? { color: 'var(--text-primary)', fontSize: '12.5px', lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
                : { color: 'var(--text-secondary)', fontSize: '12.5px', lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}
            >
              {result.description}
            </div>
          </div>

          {result.disagreements.length > 0 && (
            <div style={{ borderTop: '1px solid var(--state-running-border)', padding: '9px 11px' }}>
              <div className="u-microlabel" style={{ color: 'var(--accent-amber)', marginBottom: '5px' }}>仍有分歧</div>
              {result.disagreements.map((item, index) => (
                <div key={index} style={{ color: 'var(--text-secondary)', fontSize: '11.5px', lineHeight: 1.5 }}>
                  {index + 1}. {item}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
