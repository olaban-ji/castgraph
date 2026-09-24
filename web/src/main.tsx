import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GridApp } from './GridApp';
import { initAnalytics } from './analytics';
import './grid.css';

initAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GridApp />
  </StrictMode>,
);
