import React from 'react';
import { Dot } from '@/components/ui/Dot';
import { Chip } from '@/components/ui/Chip';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

export interface TeamMember {
  name: string;
  role: string;
  model: string;
  status: 'running' | 'done' | 'queued' | 'failed';
  currentAction: string;
}

export interface TeamCardProps {
  teamId: string;
  teamName: string;
  leader: string;
  members: TeamMember[];
  onBroadcast?: () => void;
  onDisband?: () => void;
}

export const TeamCard: React.FC<TeamCardProps> = ({
  teamId,
  teamName,
  leader,
  members,
  onBroadcast,
  onDisband,
}) => {
  return (
    <div className="team-card">
      <div className="team-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Dot state="running" />
          <span style={{ fontWeight: 700, fontSize: '13.5px', color: 'var(--text-primary)' }}>
            👥 智能体团队编队: {teamName} (#{teamId})
          </span>
          <Badge state="running">TEAM ACTIVE</Badge>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Leader: <strong>{leader}</strong></span>
          <Button variant="ghost" size="sm" onClick={onBroadcast}>
            📢 广播指令
          </Button>
          <Button variant="danger" size="sm" onClick={onDisband}>
            解散编队
          </Button>
        </div>
      </div>

      <div className="team-card-roster">
        {members.map((m, idx) => (
          <div key={idx} className="team-agent-chip">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Dot state={m.status} size={6} />
              <div>
                <div style={{ fontWeight: 600, fontSize: '12px', color: 'var(--text-primary)' }}>
                  {m.name}
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                  {m.currentAction}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
              <Chip variant="purple" style={{ height: '16px', padding: '0 4px', fontSize: '9.5px' }}>{m.role}</Chip>
              <span className="u-num" style={{ fontSize: '9.5px', color: 'var(--text-dimmed)' }}>{m.model}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
