import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { isDemoMode } from './demo/demo-mode';

import './design-system/tokens.css';
import './design-system/layout.css';
import './design-system/deck.css';
import './design-system/surfaces.css';
import './design-system/viz.css';
import './design-system/graph-engineering.css';

async function boot(): Promise<void> {
  let banner: React.ReactNode = null;
  if (isDemoMode()) {
    // Demo layer is a lazy chunk: the live build never loads it.
    const [{ installDemoTransport }, { DemoBanner }] = await Promise.all([
      import('./demo/demo-transport'),
      import('./demo/DemoBanner'),
    ]);
    installDemoTransport();
    document.documentElement.dataset.agosDemo = '1';
    banner = <DemoBanner />;
  }
  const rootEl = document.getElementById('root');
  if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <App />
        {banner}
      </React.StrictMode>
    );
  }
}

void boot();
