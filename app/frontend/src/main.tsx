import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createAuthServices } from './auth/setup';
import { loadConfig } from './config';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Created once, outside React: StrictMode must not start two logins or two refresh timers.
const config = loadConfig();
const services = createAuthServices(config);

createRoot(root).render(
  <StrictMode>
    <App config={config} services={services} />
  </StrictMode>,
);
