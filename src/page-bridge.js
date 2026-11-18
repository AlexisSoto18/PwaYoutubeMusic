/**
 * YTM Sync Lyrics - Main World Page Bridge
 * Runs in the page context (Main World) to:
 * 1. Access #movie_player.getPlayerResponse() and extract CTC/ASR timedtext (captionTracks json3).
 * 2. Intercept /youtubei/v1/browse and /youtubei/v1/player network responses to inspect lyrics
 *    payloads (including timedLyricsData if available) and emit sanitized network diagnostics.
 */

(() => {
  'use strict';

  let lastExtractedVideoId = '';
  const networkLogRing = [];

  function pushNetworkDiag(entry) {
    networkLogRing.push({
      ts: new Date().toISOString().slice(11, 23),
      ...entry
    });
    if (networkLogRing.length > 20) {
      networkLogRing.shift();
    }
    window.dispatchEvent(new CustomEvent('ytm-lyrics-net-diag', {
      detail: { logs: networkLogRing }
    }));
  }

  /**
   * Deep-search a YouTube Innertube browse/next response for any timedLyricsData / synced cues.
   */
  function findTimedLyricsInObject(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return null;
    if (Array.isArray(obj.timedLyricsData)) {
      return obj.timedLyricsData;
    }
    for (const key of Object.keys(obj)) {
      if (key === 'responseContext' || key === 'trackingParams') continue;
      const val = obj[key];
      if (val && typeof val === 'object') {
        const found = findTimedLyricsInObject(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Summarize keys inside a /youtubei/v1/browse response without sensitive tokens.
   */
  function summarizeBrowseResponse(data) {
    try {
      const topKeys = Object.keys(data || {}).filter(k => k !== 'responseContext' && k !== 'trackingParams');
      const sectionContents =
        data?.contents?.sectionListRenderer?.contents ||
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ||
        [];
      const rendererTypes = sectionContents.map(c => Object.keys(c || {})[0]).filter(Boolean);
      const shelf = sectionContents[0]?.musicDescriptionShelfRenderer;
      const footerText = shelf?.footer?.runs?.map(r => r.text).join('') || '';
      const descLen = shelf?.description?.runs?.map(r => r.text).join('')?.length || 0;
      const timedData = findTimedLyricsInObject(data);

      return {
        topKeys,
        rendererTypes,
        hasDescriptionShelf: Boolean(shelf),
        descCharLength: descLen,
        footerText,
        hasTimedLyricsData: Boolean(timedData),
        timedLyricsCount: Array.isArray(timedData) ? timedData.length : 0
      };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }

  /**
   * Hook window.fetch in Main World to observe /youtubei/v1/browse and /youtubei/v1/player responses.
   */
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (reqUrl.includes('/youtubei/v1/browse') || reqUrl.includes('/youtubei/v1/player') || reqUrl.includes('/api/timedtext')) {
          const clone = response.clone();
          clone.json().then((data) => {
            if (reqUrl.includes('/youtubei/v1/browse')) {
              const summary = summarizeBrowseResponse(data);
              pushNetworkDiag({ endpoint: 'youtubei/v1/browse', status: response.status, summary });

              const timedData = findTimedLyricsInObject(data);
              if (Array.isArray(timedData) && timedData.length > 0) {
                const lines = timedData
                  .map(item => ({
                    time: Number(item?.cueRange?.startTimeMilliseconds || 0) / 1000,
                    text: (item?.lyricLine || '').trim()
                  }))
                  .filter(l => l.text.length > 0);
                if (lines.length > 0) {
                  window.dispatchEvent(new CustomEvent('ytm-lyrics-native-timed', {
                    detail: { lines }
                  }));
                }
              }
            } else if (reqUrl.includes('/youtubei/v1/player')) {
              const vd = data?.videoDetails;
              const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
              const formats = data?.streamingData?.adaptiveFormats || [];
              const audioFormats = formats
                .filter(f => (f.mimeType || '').startsWith('audio/'))
                .map(f => ({ itag: f.itag, mime: f.mimeType, hasCipher: Boolean(f.signatureCipher) }));
              pushNetworkDiag({
                endpoint: 'youtubei/v1/player',
                status: response.status,
                videoId: vd?.videoId,
                title: vd?.title,
                author: vd?.author,
                lengthSeconds: vd?.lengthSeconds,
                captionTracksCount: tracks.length,
                captionKinds: tracks.map(t => `${t.languageCode}:${t.kind || 'manual'}`),
                audioFormats
              });
            }
          }).catch(() => {});
        }
      } catch (_) {}
      return response;
    };
  }

  /**
   * Parse YouTube's json3 timedtext format into phrase segments and word-level timestamps.
   */
  function parseJson3TimedText(json3) {
    if (!json3 || !Array.isArray(json3.events)) return [];

    const segments = [];
    for (const ev of json3.events) {
      if (typeof ev.tStartMs !== 'number' || !Array.isArray(ev.segs)) continue;

      const words = [];
      let fullText = '';

      for (const seg of ev.segs) {
        const rawWord = (seg.utf8 || '').replace(/\n/g, ' ').trim();
        if (!rawWord) continue;
        if (/^[\[\(\{].*[\]\)\}]$/.test(rawWord) || /^[♪♫♬]+$/.test(rawWord)) continue;

        const wordTime = (ev.tStartMs + (seg.tOffsetMs || 0)) / 1000;
        words.push({ time: wordTime, text: rawWord });
        fullText += (fullText ? ' ' : '') + rawWord;
      }

      const cleanText = fullText
        .replace(/\[.*?\]/g, '')
        .replace(/[♪♫♬]/g, '')
        .trim();

      if (cleanText.length > 1) {
        const startTime = words.length > 0 ? words[0].time : (ev.tStartMs / 1000);
        const endTime = (ev.tStartMs + (ev.dDurationMs || 2500)) / 1000;
        segments.push({
          time: startTime,
          endTime,
          text: cleanText,
          words
        });
      }
    }

    return segments;
  }

  /**
   * Inspect #movie_player for new videoId and extract CTC/ASR captionTracks if available.
   */
  async function checkPlayerResponse(force = false) {
    try {
      const player = document.getElementById('movie_player');
      if (!player || typeof player.getPlayerResponse !== 'function') return;

      const response = player.getPlayerResponse();
      const videoDetails = response?.videoDetails;
      const videoId = videoDetails?.videoId;
      if (!videoId) return;

      if (!force && videoId === lastExtractedVideoId) return;
      lastExtractedVideoId = videoId;

      const duration = Number(videoDetails?.lengthSeconds || 0);
      const title = videoDetails?.title || '';
      const author = videoDetails?.author || '';

      const captionTracks =
        response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

      const formats = response?.streamingData?.adaptiveFormats || [];
      const audioFormats = formats
        .filter(f => (f.mimeType || '').startsWith('audio/'))
        .map(f => ({ itag: f.itag, mime: f.mimeType }));

      pushNetworkDiag({
        endpoint: 'movie_player.getPlayerResponse()',
        videoId,
        title,
        author,
        duration,
        captionTracksCount: captionTracks.length,
        captionKinds: captionTracks.map(t => `${t.languageCode}:${t.kind || 'manual'}`),
        audioFormats
      });

      if (!captionTracks.length) {
        window.dispatchEvent(new CustomEvent('ytm-lyrics-asr-data', {
          detail: { videoId, title, author, duration, segments: [], hasASR: false }
        }));
        return;
      }

      const preferredTrack =
        captionTracks.find(t => t.kind !== 'asr') ||
        captionTracks[0];

      if (!preferredTrack || !preferredTrack.baseUrl) return;

      const json3Url = `${preferredTrack.baseUrl}&fmt=json3`;
      const res = await fetch(json3Url, { credentials: 'same-origin' });
      if (!res.ok) return;

      const json3 = await res.json();
      const segments = parseJson3TimedText(json3);

      pushNetworkDiag({
        endpoint: 'api/timedtext (json3)',
        videoId,
        segmentsCount: segments.length,
        sampleFirstSegment: segments[0] || null
      });

      window.dispatchEvent(new CustomEvent('ytm-lyrics-asr-data', {
        detail: {
          videoId,
          title,
          author,
          duration,
          segments,
          hasASR: segments.length > 0
        }
      }));
    } catch (e) {
      // Silently ignore Main World extraction errors
    }
  }

  window.addEventListener('ytm-lyrics-request-asr', () => {
    checkPlayerResponse(true);
  });

  setInterval(() => {
    checkPlayerResponse(false);
  }, 1200);
})();
