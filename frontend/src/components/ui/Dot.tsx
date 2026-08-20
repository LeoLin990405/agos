import React from 'react';
import { StateLamp, STATE_DEFS } from '@/design-system/tokens';

export interface DotProps {
  state: StateLamp;
  className?: string;
  size?: number;
  title?: string;
}

export const Dot: React.FC<DotProps> = ({ state, className = '', size, title }) => {
  const def = STATE_DEFS[state] || STATE_DEFS.queued;
  const style = size ? { width: size, height: size } : undefined;

  return (
    <span
      className={`u-dot ${def.dotClass} ${className}`}
      style={style}
      title={title || def.label}
      aria-label={def.label}
    />
  );
};
