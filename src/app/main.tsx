// Entry of the React shell. Package 1H owns src/app; see README.md.
import '@fontsource-variable/jost/wght.css';
import '@fontsource/commit-mono/400.css';
import './ui/ui.css';
import './shell.css';
import { createRoot } from 'react-dom/client';
import { config } from '../config';
import { App } from './App';
import { closeSession, fakeOptionsFromUrl, openSource } from './session';
import { initEnvironment, useApp } from './store';

document.title = config.app.title;
initEnvironment();

// No StrictMode: its double-run of effects would create, dispose and re-create WebGL renderers on
// the same canvas, which the renderer is not asked to survive.
createRoot(document.getElementById('root')!).render(<App />);

// /?fake=2000 walks landing → waiting → map on a synthetic model, with no folder involved.
const fake = fakeOptionsFromUrl();
if (fake) void openSource({ kind: 'synthetic', files: fake.files ?? 1000, seed: fake.seed });

// A handle for the console, scripts/shot.mjs --eval and browser tests (development builds only).
if (import.meta.env.DEV) {
  (window as unknown as { __gitmapApp: unknown }).__gitmapApp = { store: useApp, open: openSource, close: closeSession };
}
