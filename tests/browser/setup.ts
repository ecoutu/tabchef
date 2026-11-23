// The browser project's stand-in for WxtVitest's `virtual:wxt-setup` (see wxtSetupForBrowser in vitest.config.ts):
// the extension APIs are WXT's in-memory fakeBrowser, as in the jsdom tests.
import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

vi.stubGlobal('chrome', fakeBrowser);
vi.stubGlobal('browser', fakeBrowser);
