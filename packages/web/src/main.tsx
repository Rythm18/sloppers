import '@fontsource/silkscreen/400.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles/tokens.css';
import './styles/app.css';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(<App />);
