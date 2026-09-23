import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GridApp } from './GridApp';
import { viewOf } from './ring';
import { initAnalytics } from './analytics';
import './styles.css';
import './grid.css';

initAnalytics();

// The revamp is the map now. `?view=map` still reaches the one that grew
// hop by hop, until the old view is taken out.
const Root = viewOf() === 'map' ? App : GridApp;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
