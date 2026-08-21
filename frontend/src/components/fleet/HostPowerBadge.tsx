import React, { useEffect, useState } from 'react';
import './HostPowerBadge.css';

export type HostPowerState = 'reachable' | 'unreachable' | 'waking';

export interface HostPowerBadgeProps {
  state: HostPowerState;
  etaMs?: number;
  error?: string | null;
}

export const HostPowerBadge: React.FC<HostPowerBadgeProps> = ({ state, etaMs, error }) => {
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, etaMs ?? 0));

  useEffect(() => {
    setRemainingMs(Math.max(0, etaMs ?? 0));
    if (state !== 'waking' || !etaMs || etaMs <= 0) return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setRemainingMs(Math.max(0, etaMs - (Date.now() - startedAt)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [etaMs, state]);

  const seconds = remainingMs > 0 ? Math.ceil(remainingMs / 1_000) : undefined;
  const label = state === 'reachable'
    ? '可达'
    : state === 'waking'
      ? `唤醒中${seconds === undefined ? '' : ` · ${seconds} 秒`}`
      : '不可达';

  return (
    <span
      className={`host-power-badge is-${state}`}
      title={error || label}
      role="status"
    >
      <span className="host-power-badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
};
