/**
 * HistoryIntegrity — presentational completeness banner.
 *
 * Shows that the current follow window is not the full session, and offers
 * retry / load-earlier. No store subscription, no router, no fold rewrite.
 * ReplayScrubber is a render-window seeker and is not used here.
 */
import React from 'react';
import { Button } from '@/components/ui/Button';

export interface HistoryIntegrityProps {
  historyIncomplete: boolean;
  retryable?: boolean;
  hasMore?: boolean;
  loading?: boolean;
  error?: string;
  onLoadEarlier?: () => void;
  onRetry?: () => void;
}

export function historyIntegrityVisible(
  props: Pick<HistoryIntegrityProps, 'historyIncomplete' | 'retryable'>,
): boolean {
  return props.historyIncomplete === true || props.retryable === true;
}

export function historyIntegrityCopy(
  props: Pick<HistoryIntegrityProps, 'retryable' | 'error'>,
): { banner: string; action: string } {
  if (props.retryable === true) {
    const detail = props.error !== undefined && props.error.trim() !== ''
      ? `：${props.error}`
      : '';
    return {
      banner: `更早的历史未能加载${detail}。当前窗口不是完整会话。`,
      action: '重试',
    };
  }
  return {
    banner: '当前窗口不是完整会话，还有更早的历史。',
    action: '加载更早的历史',
  };
}

export const HistoryIntegrity: React.FC<HistoryIntegrityProps> = ({
  historyIncomplete,
  retryable = false,
  loading = false,
  error,
  onLoadEarlier,
  onRetry,
}) => {
  if (!historyIntegrityVisible({ historyIncomplete, retryable })) return null;

  const copy = historyIntegrityCopy({ retryable, error });
  const action = retryable ? (onRetry ?? onLoadEarlier) : onLoadEarlier;
  const failed = retryable === true;

  return (
    <div
      className={failed ? 'surface-status surface-status--fail' : 'surface-status surface-status--amber'}
      role={failed ? 'alert' : 'status'}
      aria-live={failed ? 'assertive' : 'polite'}
      data-history-incomplete="true"
      data-history-retryable={failed ? 'true' : 'false'}
    >
      <span>{copy.banner}</span>
      {action !== undefined && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={action}
        >
          {copy.action}
        </Button>
      )}
    </div>
  );
};
