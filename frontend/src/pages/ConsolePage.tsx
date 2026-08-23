import React, { useEffect, useState } from 'react';
import { AppTopbar } from '@/components/layout/AppTopbar';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Dot } from '@/components/ui/Dot';
import { FleetView } from '@/components/console/FleetView';
import { SessionsView } from '@/components/console/SessionsView';
import { LineageView } from '@/components/console/LineageView';
import { PlansView } from '@/components/console/PlansView';
import { SkillsView } from '@/components/console/SkillsView';
import { CouncilLedgerView } from '@/components/console/CouncilLedgerView';
import { RoutesView } from '@/components/console/RoutesView';
import { OutcomesCoverage } from '@/components/console/OutcomesCoverage';
import { TraceView } from '@/components/console/TraceView';
import { overviewLamp, RealOverview, useConsoleLive } from '@/pages/console-live';
import type { SkillsConsoleTab } from '@/pages/app-navigation';

export type ConsoleTab = 'overview' | 'fleet' | 'sessions' | 'lineage' | 'trace' | 'plans' | 'skills' | 'ledger' | 'routes';

export interface ConsolePageProps {
  initialTab?: ConsoleTab;
  initialFleetBatchId?: string;
  initialSkillsTab?: SkillsConsoleTab;
  initialSkill?: string;
  onNavigateChat?: (sessionId?: string) => void;
  onNavigateGraph?: () => void;
}

export const ConsolePage: React.FC<ConsolePageProps> = ({
  initialTab = 'overview',
  initialFleetBatchId,
  initialSkillsTab,
  initialSkill,
  onNavigateChat,
  onNavigateGraph,
}) => {
  const [activeTab, setActiveTab] = useState<ConsoleTab>(initialTab);
  const [skillsTab, setSkillsTab] = useState<SkillsConsoleTab | undefined>(initialSkillsTab);
  const [selectedFleetBatchId, setSelectedFleetBatchId] = useState<string | undefined>(initialFleetBatchId);
  const [densityMode, setDensityMode] = useState<'dense' | 'sparse'>('dense');

  useEffect(() => { setActiveTab(initialTab); }, [initialTab]);
  useEffect(() => { setSkillsTab(initialSkillsTab); }, [initialSkillsTab]);
  useEffect(() => { setSelectedFleetBatchId(initialFleetBatchId); }, [initialFleetBatchId]);
  const consoleLive = useConsoleLive({
    overviewEnabled: activeTab === 'overview' || activeTab === 'plans',
    progressEnabled: activeTab === 'overview',
  });
  const overviewFresh = consoleLive.overviewStatus === 'ready';

  return (
    <div className="console-workspace">
      {/* 内部功能导航 */}
      <nav className="console-nav-rail">
        <div className="console-nav-label u-microlabel">控制台功能面</div>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'overview' ? 'is-active' : ''}`}
          aria-label="概览遥测"
          onClick={() => setActiveTab('overview')}
        >
          <span>概览遥测</span>
          <Dot state={overviewLamp(consoleLive.overviewStatus)} size={6} />
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'fleet' ? 'is-active' : ''}`}
          aria-label="机器与机架"
          onClick={() => setActiveTab('fleet')}
        >
          <span>机器与机架</span>
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'sessions' ? 'is-active' : ''}`}
          aria-label="会话矩阵"
          onClick={() => setActiveTab('sessions')}
        >
          <span>会话矩阵</span>
          {overviewFresh && consoleLive.sessionsTotal !== undefined && (
            <span className="u-num console-nav-count">{consoleLive.sessionsTotal}</span>
          )}
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'lineage' ? 'is-active' : ''}`}
          aria-label="智能体谱系"
          onClick={() => setActiveTab('lineage')}
        >
          <span>智能体谱系</span>
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'trace' ? 'is-active' : ''}`}
          aria-label="轨迹时间流"
          onClick={() => setActiveTab('trace')}
        >
          <span>轨迹时间流</span>
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'plans' ? 'is-active' : ''}`}
          aria-label="计划与目标"
          onClick={() => setActiveTab('plans')}
        >
          <span>计划与目标</span>
          {overviewFresh && consoleLive.plansTotal !== undefined && (
            <span className="u-num console-nav-count">{consoleLive.plansTotal}</span>
          )}
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'skills' ? 'is-active' : ''}`}
          aria-label="技能注册表"
          onClick={() => setActiveTab('skills')}
        >
          <span>技能注册表</span>
          {overviewFresh && consoleLive.skills !== undefined && (
            <span className="u-num console-nav-count">{consoleLive.skills}</span>
          )}
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'routes' ? 'is-active' : ''}`}
          aria-label="路由决策"
          onClick={() => setActiveTab('routes')}
        >
          <span>路由决策</span>
        </button>

        <button
          type="button"
          className={`console-nav-item ${activeTab === 'ledger' ? 'is-active' : ''}`}
          aria-label="读图台账"
          onClick={() => setActiveTab('ledger')}
        >
          <span>读图台账</span>
        </button>
      </nav>

      {/* 主展示区 */}
      <main className="app-stage">
        <AppTopbar
          title={`AgOS 控制台 · ${
            activeTab === 'overview'
              ? '概览遥测'
              : activeTab === 'fleet'
              ? '机器与机架'
              : activeTab === 'sessions'
              ? '会话矩阵'
              : activeTab === 'lineage'
              ? '智能体谱系'
              : activeTab === 'trace'
              ? '轨迹时间流'
              : activeTab === 'plans'
              ? '计划与目标'
              : activeTab === 'routes'
              ? '路由决策'
              : activeTab === 'ledger'
              ? '读图台账'
              : '技能注册表'
          }`}
          rightActions={
            activeTab === 'overview' ? (
              <SegmentedControl
                value={densityMode}
                onChange={setDensityMode}
                options={[
                  { value: 'dense', label: '紧凑' },
                  { value: 'sparse', label: '舒展' },
                ]}
              />
            ) : undefined
          }
        />

        <div className="console-body">
          {activeTab === 'fleet' && (
            <FleetView
              selectedBatchId={selectedFleetBatchId}
              onSelectBatch={setSelectedFleetBatchId}
            />
          )}
          {activeTab === 'sessions' && <SessionsView onSelectSession={(id) => onNavigateChat?.(id)} />}
          {activeTab === 'lineage' && <LineageView />}
          {activeTab === 'trace' && <TraceView onSelectSession={(id) => onNavigateChat?.(id)} />}
          {activeTab === 'plans' && <PlansView overviewTotal={overviewFresh ? consoleLive.plansTotal : undefined} />}
          {activeTab === 'skills' && (
            <SkillsView initialTab={skillsTab} initialSkill={initialSkill} />
          )}
          {activeTab === 'routes' && <><RoutesView /><OutcomesCoverage /></>}
          {activeTab === 'ledger' && <CouncilLedgerView />}

          {activeTab === 'overview' && (
            <RealOverview
              live={consoleLive}
              density={densityMode}
              onNavigateChat={onNavigateChat}
              onNavigateLineage={() => setActiveTab('lineage')}
              onNavigateStudio={() => {
                setSkillsTab('studio');
                setActiveTab('skills');
              }}
              onNavigateAssemble={() => setActiveTab('routes')}
            />
          )}
        </div>
      </main>
    </div>
  );
};
