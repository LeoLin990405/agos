import React from 'react';
import { StateLamp, STATE_DEFS } from '@/design-system/tokens';

export interface BadgeProps {
  state?: StateLamp;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const Badge: React.FC<BadgeProps> = ({ state, children, className = '', style }) => {
  const badgeClass = state ? STATE_DEFS[state]?.badgeClass : '';
  return (
    <span className={`badge ${badgeClass} ${className}`} style={style}>
      {children}
    </span>
  );
};
