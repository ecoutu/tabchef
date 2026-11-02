import { browser } from 'wxt/browser';
import { startPageWatch } from '../engine/page-watch';

// Registered at runtime for the hosts Tabchef holds (src/engine/watch-registration.ts), never in the manifest.
export default defineContentScript({
  registration: 'runtime',
  main() {
    const w = window as unknown as { __tabchefWatch?: boolean };
    if (w.__tabchefWatch) return; // injected twice: keep the single watcher
    w.__tabchefWatch = true;
    startPageWatch({ doc: document, win: window, send: (m) => browser.runtime.sendMessage(m) });
  },
});
