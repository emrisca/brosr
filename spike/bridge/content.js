// Content script entry. The core is a module, so it loads from the extension
// origin through web_accessible_resources. The page origin and its CSP never
// apply to that URL.

(async () => {
  try {
    const core = await import(browser.runtime.getURL('core/browser-entry.mjs'));
    await core.start();
  } catch (error) {
    document.documentElement.dataset.brosrError = String((error && error.message) || error);
  }
})();
