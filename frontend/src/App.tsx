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
import { fleetConsoleEntry } from '@/pages/app-navigation';

const AppContent: React.FC = () => {
  useSymRespiration();
  const [currentTab, setCurrentTab] = useState<MainTab>('chat');
  const [consoleEntry, setConsoleEntry] = useState<{
    tab: ConsoleTab;
    fleetBatchId?: string;
  }>({ tab: 'overview' });
  // ⚠️ 用完必须清:它是一次性的「跳转意图」,不是持久状态。不清的话,
  // 从控制台点过一次「接入」之后,**之后每次回对话页都会被它拉回那条会话**
  // (2026-08-22 验收 P1)。消费方 ChatPage 收到后回调 onConsumed 清掉。
  const [pendingSessionId, setPendingSessionId] = useState<string | undefined>();
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
          onNavigateFleet={(batchId) => {
            setConsoleEntry(fleetConsoleEntry(batchId));
            setCurrentTab('console');
          }}
          onNavigateGraph={() => setCurrentTab('graph')}
        />
      )}

      {currentTab === 'console' && (
        <ConsolePage
          initialTab={consoleEntry.tab}
          initialFleetBatchId={consoleEntry.fleetBatchId}
          onNavigateChat={(sessionId) => {
            setPendingSessionId(sessionId);
            setCurrentTab('chat');
          }}
          onNavigateGraph={() => setCurrentTab('graph')}
        />
      )}

      {currentTab === 'graph' && <MemoryGraphPage />}

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
