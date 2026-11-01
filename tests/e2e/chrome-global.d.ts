// Code passed to page.evaluate / worker.evaluate runs in the extension, where `chrome` is the global extension API.
declare const chrome: typeof import('@wxt-dev/browser').Browser;
