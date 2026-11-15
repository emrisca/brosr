// Page entry for a build whose content script cannot import a module, which is
// the Chrome case. The loader asks for this file instead, so the core still
// owns the page and the room still joins the relay.
import { start } from './browser-entry.mjs';

start().catch((error) => {
  document.documentElement.dataset.brosrError = String((error && error.message) || error);
});
