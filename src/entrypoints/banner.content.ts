import { browser } from 'wxt/browser';
import { bannerText, type BannerAck, type BannerChoice, type BannerShowMessage, type CloseChoiceMessage } from '../engine/messages';

const HOST_ID = 'tabchef-dedupe-banner';

export default defineContentScript({
  registration: 'runtime',
  main() {
    const w = window as unknown as { __tabchefBanner?: boolean };
    if (w.__tabchefBanner) return; // injected twice: keep the single listener
    w.__tabchefBanner = true;

    // Form edits are reported by the watch content script (watch.content.ts), not here.
    browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
      void sender;
      const m = msg as Partial<BannerShowMessage> | null;
      if (m?.type !== 'banner.show' || !m.payload) return;
      if (m.payload.kind === 'undo') showUndo(m.payload.entryId, m.payload.text);
      else if (m.payload.kind === 'protected-close') showProtectedClose(m.payload.text);
      else show(m.payload.tabId, m.payload.existingTabId, m.payload.groupTitle);
      sendResponse({ ok: true } satisfies BannerAck); // after rendering: lets the worker drop its pending entry
    });
  },
});

const UNDO_TOAST_MS = 10_000;

function build(): { host: HTMLElement; box: HTMLElement; mount: () => void } {
  document.getElementById(HOST_ID)?.remove();
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .box{font:13px/1.4 system-ui,sans-serif;background:#202124;color:#fff;border-radius:8px;padding:10px 12px;
      box-shadow:0 2px 12px rgba(0,0,0,.4);display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:480px}
    button{font:inherit;border:1px solid #8ab4f8;background:transparent;color:#8ab4f8;border-radius:4px;padding:3px 8px;cursor:pointer}
    button:hover{background:rgba(138,180,248,.15)}
  `;
  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('role', 'alert');
  return { host, box, mount: () => { root.append(style, box); document.documentElement.append(host); } };
}

function showUndo(entryId: string, message: string): void {
  const { host, box, mount } = build();
  const text = document.createElement('span');
  text.textContent = message;
  const b = document.createElement('button');
  b.textContent = 'Undo';
  b.addEventListener('click', () => {
    void browser.runtime.sendMessage({ type: 'banner.choice', choice: 'undo', entryId });
    host.remove();
  });
  box.append(text, b);
  mount();
  setTimeout(() => host.remove(), UNDO_TOAST_MS);
}

/**
 * "Close this tab? [Close] [Keep]" for a tab a close rule matched while it was protected or in use (D22). Keep is the
 * default: the banner stays until answered, nothing gets focus (it must not steal a form's focus) and no answer keeps
 * the tab.
 */
function showProtectedClose(message: string): void {
  const { host, box, mount } = build();
  const text = document.createElement('span');
  text.textContent = message;
  box.append(text);
  for (const [label, choice] of [['Close', 'close'], ['Keep', 'keep']] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      void browser.runtime.sendMessage({ type: 'banner.closeChoice', choice } satisfies CloseChoiceMessage);
      host.remove();
    });
    box.append(b);
  }
  mount();
}

function show(tabId: number, existingTabId: number, groupTitle: string | undefined): void {
  const { host, box, mount } = build();
  const text = document.createElement('span');
  text.textContent = bannerText(groupTitle);
  box.append(text);

  const choose = (choice: BannerChoice) => {
    void browser.runtime.sendMessage({ type: 'banner.choice', choice, tabId, existingTabId });
    host.remove();
  };
  for (const [label, choice] of [
    ['Switch', 'switch'], ['Keep both', 'keep'], ['Always switch for this site', 'always-switch-site'],
  ] as const) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => choose(choice));
    box.append(b);
  }
  mount();
}
