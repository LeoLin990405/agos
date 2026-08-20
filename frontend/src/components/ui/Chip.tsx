import React from 'react';

export interface ChipProps {
  children: React.ReactNode;
  active?: boolean;
  variant?: 'default' | 'purple' | 'amber' | 'cyan' | 'red';
  className?: string;
  style?: React.CSSProperties;
}

export const Chip: React.FC<ChipProps> = ({
  children,
  active = false,
  variant = 'default',
  className = '',
  style,
}) => {
  const variantClass =
    variant === 'purple'
      ? 'u-chip--purple'
      : variant === 'amber'
      ? 'u-chip--amber'
      : variant === 'red'
      ? 'u-chip--red'
      : '';

  return (
    <span
      className={`u-chip ${active ? 'is-on' : ''} ${variantClass} ${className}`}
      style={style}
    >
      {children}
    </span>
  );
};
