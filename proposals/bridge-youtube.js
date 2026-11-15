// Page-scope hand-in for the YouTube player.
//
// The IFrame player object lives in the page's own world. A content script runs
// in a sandbox and cannot see it, so the bridge injects this file into the page
// as a classic script. The file then publishes the player on the window, where
// core/browser-entry.mjs reads it as __brosrYouTubePlayer.
//
// The bridge adds three things to content.js:
//
//   const script = document.createElement('script');
//   script.src = browser.runtime.getURL('bridge-youtube.js');
//   script.onload = () => script.remove();
//   document.documentElement.append(script);
//
// The manifest also needs "bridge-youtube.js" in web_accessible_resources, or
// the page cannot load it from the extension origin.
//
// The room reads the window once, when the core starts. This script publishes
// the first usable player it finds, and republishes after a YouTube navigation
// swaps the player for a new one.
(() => {
  const NAME = '__brosrYouTubePlayer';
  const SELECTORS = ['#movie_player', '.html5-video-player'];
  const POLL_MS = 250;
  const ATTEMPTS = 120;

  const usable = (player) =>
    Boolean(player) &&
    typeof player.getCurrentTime === 'function' &&
    typeof player.seekTo === 'function';

  const fromDom = () => {
    for (const selector of SELECTORS) {
      const node = document.querySelector(selector);
      if (usable(node)) return node;
    }
    return null;
  };

  // An embed has no player node. The IFrame API keys its players by video id.
  const fromApi = () => {
    const api = window.YT;
    if (!api || typeof api.get !== 'function') return null;
    const id = new URLSearchParams(window.location.search).get('v');
    if (!id) return null;
    try {
      const player = api.get(id);
      return usable(player) ? player : null;
    } catch {
      return null;
    }
  };

  const publish = () => {
    const player = fromDom() || fromApi();
    // A page that published its own player keeps it. A new node replaces an old
    // one, which is what a YouTube navigation leaves behind.
    if (!player) return usable(window[NAME]);
    if (player !== window[NAME]) window[NAME] = player;
    return true;
  };

  let attempts = 0;
  let timer = null;

  if (!publish()) {
    timer = window.setInterval(() => {
      attempts += 1;
      if (publish() || attempts >= ATTEMPTS) {
        window.clearInterval(timer);
        timer = null;
      }
    }, POLL_MS);
  }

  document.addEventListener('yt-navigate-finish', publish);
})();
