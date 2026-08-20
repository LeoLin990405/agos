import React, { useState } from 'react';
import { ThemeProvider } from '@/design-system/theme-context';
import { useSymRespiration } from '@/design-system/use-sym-respiration';
import { AppRail, MainTab } from '@/components/layout/AppRail';
import { ChatPage } from '@/pages/ChatPage';
import { ConsolePage } from '@/pages/ConsolePage';
import { MemoryGraphPage } from '@/pages/MemoryGraphPage';
import { SettingsPage } from '@/pages/SettingsPage';

const AppContent: React.FC = () => {
  useSymRespiration();
  const [currentTab, setCurrentTab] = useState<MainTab>('chat');

  return (
    <div className="app-container">
      <AppRail currentTab={currentTab} onSelectTab={setCurrentTab} unreadCount={1} />

      {currentTab === 'chat' && (
        <ChatPage
          onNavigateConsole={() => setCurrentTab('console')}
          onNavigateGraph={() => setCurrentTab('graph')}
        />
      )}

      {currentTab === 'console' && (
        <ConsolePage
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
