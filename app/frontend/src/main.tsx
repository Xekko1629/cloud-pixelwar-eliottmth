import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createAuthServices } from './auth/setup';
import { loadConfig } from './config';
import { createLiveCanvas } from './realtime/setup';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Created once, outside React: StrictMode must not start two logins, two refresh timers
// or open the listeners twice.
const config = loadConfig();
const services = createAuthServices(config);
const live = createLiveCanvas(config, services);
void live.start();

createRoot(root).render(
  <StrictMode>
    <App config={config} services={services} live={live} />
  </StrictMode>,
);
