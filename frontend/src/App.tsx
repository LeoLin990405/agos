import React, { useState } from 'react';
import { ThemeProvider } from '@/design-system/theme-context';
import { useSymRespiration } from '@/design-system/use-sym-respiration';
import { AppRail } from '@/components/layout/AppRail';
import { ChatPage } from '@/pages/ChatPage';
import { ConsolePage } from '@/pages/ConsolePage';
import { LineagePage } from '@/pages/LineagePage';

const AppContent: React.FC = () => {
  useSymRespiration();
  const [currentTab, setCurrentTab] = useState<'chat' | 'console' | 'lineage'>('chat');

  return (
    <div className="app-container">
      <AppRail currentTab={currentTab} onSelectTab={setCurrentTab} unreadCount={1} />
      {currentTab === 'chat' && <ChatPage onNavigateConsole={() => setCurrentTab('console')} />}
      {currentTab === 'console' && (
        <ConsolePage
          onNavigateChat={() => setCurrentTab('chat')}
          onNavigateLineage={() => setCurrentTab('lineage')}
        />
      )}
      {currentTab === 'lineage' && <LineagePage />}
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
