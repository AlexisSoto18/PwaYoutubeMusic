/**
 * YTM Sync Lyrics - Main World Page Bridge
 * Runs in the page context (Main World) to access #movie_player.getPlayerResponse(),
 * extract YouTube's internal CTC/ASR timedtext (captionTracks json3) for Forced Alignment,
 * and broadcast accurate track metadata to the Content Script.
 */

(() => {
  'use strict';

  let lastExtractedVideoId = '';

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
        // Skip music symbol tags like "[Música]" or "♪"
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

      if (!captionTracks.length) {
        window.dispatchEvent(new CustomEvent('ytm-lyrics-asr-data', {
          detail: { videoId, title, author, duration, segments: [], hasASR: false }
        }));
        return;
      }

      // Prefer manual lyrics captions first, then ASR auto-generated captions
      const preferredTrack =
        captionTracks.find(t => t.kind !== 'asr') ||
        captionTracks[0];

      if (!preferredTrack || !preferredTrack.baseUrl) return;

      const json3Url = `${preferredTrack.baseUrl}&fmt=json3`;
      const res = await fetch(json3Url, { credentials: 'same-origin' });
      if (!res.ok) return;

      const json3 = await res.json();
      const segments = parseJson3TimedText(json3);

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

  // Listen for explicit requests from Content Script
  window.addEventListener('ytm-lyrics-request-asr', () => {
    checkPlayerResponse(true);
  });

  // Poll lightly for videoId changes in #movie_player
  setInterval(() => {
    checkPlayerResponse(false);
  }, 1200);
})();
