/**
 * YTM Sync Lyrics - Background Service Worker
 * 1. Handles privileged cross-origin API requests (LRCLIB) bypassing page-level CSP.
 * 2. Manages the MV3 Offscreen Document running Silero VAD v5 ONNX WebAssembly inference.
 */

let offscreenCreatingPromise = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');

  if (typeof chrome.runtime.getContexts === 'function') {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existingContexts.length > 0) {
      return true;
    }
  }

  if (offscreenCreatingPromise) {
    await offscreenCreatingPromise;
    return true;
  }

  offscreenCreatingPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run Silero VAD v5 ONNX WebAssembly neural voice detection for synced lyrics'
  });

  try {
    await offscreenCreatingPromise;
  } catch (err) {
    if (!String(err?.message || '').includes('single offscreen document')) {
      throw err;
    }
  } finally {
    offscreenCreatingPromise = null;
  }

  return true;
}

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
    return true;
  }

  if (message?.type === 'SILERO_VAD_INFER') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_SILERO_INFER',
          samples: message.samples,
          reset: Boolean(message.reset)
        });
        sendResponse(result || { ok: false, error: 'Empty offscreen response' });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === 'SILERO_VAD_RESET') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        await chrome.runtime.sendMessage({ type: 'OFFSCREEN_SILERO_RESET' });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
});
