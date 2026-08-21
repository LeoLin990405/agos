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
          onNavigateChat={() => setCurrentTab('chat')}
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
