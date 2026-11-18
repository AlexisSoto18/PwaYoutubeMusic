/**
 * YTM Sync Lyrics - Background Service Worker
 * Handles privileged cross-origin API requests bypassing page-level CSP.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'FETCH_API' && message.url) {
    (async () => {
      try {
        const res = await fetch(message.url);
        if (!res.ok) {
          sendResponse({ success: false, status: res.status });
          return;
        }
        const data = await res.json();
        sendResponse({ success: true, data });
      } catch (err) {
        console.warn('[YTM Sync Lyrics SW] Fetch failed:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keeps message channel open for async sendResponse
  }
});
