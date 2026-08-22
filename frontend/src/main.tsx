import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

import './design-system/tokens.css';
import './design-system/layout.css';
import './design-system/deck.css';
import './design-system/surfaces.css';
import './design-system/viz.css';
import './design-system/graph-engineering.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
