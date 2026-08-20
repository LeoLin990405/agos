import React from 'react';

export interface KpiCardProps {
  label: string;
  value: React.ReactNode;
  subValue?: React.ReactNode;
  unit?: string;
  trend?: string;
  trendType?: 'up' | 'down' | 'neutral';
  headerRight?: React.ReactNode;
  className?: string;
}

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  subValue,
  unit,
  trend,
  trendType = 'up',
  headerRight,
  className = '',
}) => {
  return (
    <div className={`u-kpi-card ${className}`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="u-microlabel">{label}</span>
        {headerRight}
      </div>
      <div className="u-kpi-val u-num">
        {value}{' '}
        {unit && (
          <span style={{ fontSize: '14px', color: 'var(--text-tertiary)', fontWeight: 500 }}>
            {unit}
          </span>
        )}
      </div>
      <div className="u-kpi-sub">
        {trend && (
          <span className={`u-num ${trendType === 'up' ? 'trend-up' : trendType === 'down' ? 'trend-down' : ''}`}>
            {trend}
          </span>
        )}
        {subValue && <span className="u-num">{subValue}</span>}
      </div>
    </div>
  );
};
