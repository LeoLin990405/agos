import React, { useState, useSyncExternalStore } from 'react';
import { ThemeProvider } from '@/design-system/theme-context';
import { sessionsStore } from '@/stores/live';
import { useSymRespiration } from '@/design-system/use-sym-respiration';
import { AppRail, MainTab } from '@/components/layout/AppRail';
import { ChatPage } from '@/pages/ChatPage';
import { ConsolePage } from '@/pages/ConsolePage';
import type { ConsoleTab } from '@/pages/ConsolePage';
import { MemoryGraphPage } from '@/pages/MemoryGraphPage';
import { SettingsPage } from '@/pages/SettingsPage';
import {
  fleetConsoleEntry,
  memoryIntent,
  routesConsoleEntry,
  skillsConsoleEntry,
  studioConsoleEntry,
  type MemoryIntent,
  type SkillsConsoleEntry,
} from '@/pages/app-navigation';

const AppContent: React.FC = () => {
  useSymRespiration();
  const [currentTab, setCurrentTab] = useState<MainTab>('chat');
  const [consoleEntry, setConsoleEntry] = useState<{
    tab: ConsoleTab;
    fleetBatchId?: string;
    skillsTab?: SkillsConsoleEntry['skillsTab'];
    skill?: string;
  }>({ tab: 'overview' });
  // ⚠️ 用完必须清:它是一次性的「跳转意图」,不是持久状态。不清的话,
  // 从控制台点过一次「接入」之后,**之后每次回对话页都会被它拉回那条会话**
  // (2026-08-22 验收 P1)。消费方 ChatPage 收到后回调 onConsumed 清掉。
  const [pendingSessionId, setPendingSessionId] = useState<string | undefined>();
  const [memoryJump, setMemoryJump] = useState<MemoryIntent | undefined>();
  const openMemory = (intent?: MemoryIntent): void => {
    setMemoryJump(memoryIntent(intent));
    setCurrentTab('graph');
  };
  // 徽标=真实运行中会话数(原先硬编码 1,属假数据)
  const sessions = useSyncExternalStore(sessionsStore.subscribe, sessionsStore.getSnapshot);
  const runningCount = sessions.rows.filter((r) => r.running).length;

  return (
    <div className="app-container">
      <AppRail
        currentTab={currentTab}
        onSelectTab={(tab) => {
          if (tab === 'console') setConsoleEntry({ tab: 'overview' });
          setCurrentTab(tab);
        }}
        unreadCount={runningCount}
      />

      {currentTab === 'chat' && (
        <ChatPage
          initialSessionId={pendingSessionId}
          onInitialSessionConsumed={() => setPendingSessionId(undefined)}
          onNavigateConsole={() => {
            setConsoleEntry({ tab: 'overview' });
            setCurrentTab('console');
          }}
          onNavigateStudio={() => {
            setConsoleEntry(studioConsoleEntry());
            setCurrentTab('console');
          }}
          onNavigateAssemble={() => {
            setConsoleEntry(routesConsoleEntry());
            setCurrentTab('console');
          }}
          onNavigateFleet={(batchId) => {
            setConsoleEntry(fleetConsoleEntry(batchId));
            setCurrentTab('console');
          }}
          onNavigateGraph={openMemory}
        />
      )}

      {currentTab === 'console' && (
        <ConsolePage
          initialTab={consoleEntry.tab}
          initialFleetBatchId={consoleEntry.fleetBatchId}
          initialSkillsTab={consoleEntry.skillsTab}
          initialSkill={consoleEntry.skill}
          onNavigateChat={(sessionId) => {
            setPendingSessionId(sessionId);
            setCurrentTab('chat');
          }}
          onNavigateGraph={() => openMemory()}
        />
      )}

      {currentTab === 'graph' && (
        <MemoryGraphPage
          intent={memoryJump}
          onIntentConsumed={() => setMemoryJump(undefined)}
          onNavigateChat={(sessionId) => {
            setPendingSessionId(sessionId);
            setCurrentTab('chat');
          }}
          onNavigateSkills={(entry) => {
            setConsoleEntry(skillsConsoleEntry(entry));
            setCurrentTab('console');
          }}
        />
      )}

      {currentTab === 'settings' && <SettingsPage />}
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
};

export default App;
