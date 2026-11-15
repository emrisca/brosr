// Content script entry. The core is a module, so it loads from the extension
// origin through web_accessible_resources. The page origin and its CSP never
// apply to that URL.
//
// A Chrome content script cannot import a module, so the fallback hands the
// same file to the page as a module script. The room still runs, and only the
// panel messages are out of reach from there.

const api = globalThis.browser || globalThis.chrome;

(async () => {
  const url = api.runtime.getURL('core/browser-entry.mjs');
  try {
    const core = await import(url);
    await core.start();
  } catch (error) {
    try {
      const tag = document.createElement('script');
      tag.type = 'module';
      tag.src = api.runtime.getURL('core/page-entry.mjs');
      tag.dataset.brosrEntry = 'page';
      document.documentElement.append(tag);
    } catch (cause) {
      document.documentElement.dataset.brosrError = String(
        (cause && cause.message) || cause || (error && error.message) || error
      );
    }
  }
})();
