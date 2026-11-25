import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadConfig } from './config';
import { createLiveCanvas } from './realtime/setup';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Created once, outside React: StrictMode must not open the listeners twice.
const config = loadConfig();
const live = createLiveCanvas(config);
void live.start();

createRoot(root).render(
  <StrictMode>
    <App config={config} live={live} />
  </StrictMode>,
);
