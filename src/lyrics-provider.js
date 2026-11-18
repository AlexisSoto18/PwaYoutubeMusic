/**
 * YTM Sync Lyrics - Lyrics Provider & Parser Module
 * Handles LRC parsing, metadata sanitization, cascaded LRCLIB queries,
 * and duration-aware result selection.
 */

(() => {
  'use strict';

  window.YTMLyrics = window.YTMLyrics || {};

  /**
   * Parse LRC formatted text into structured array of objects.
   */
  function parseLRC(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split('\n');
    const regex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/;
    const parsed = [];

    for (const line of lines) {
      const match = line.match(regex);
      if (match) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseInt(match[2], 10);
        const msRaw = match[3] || '0';
        const milliseconds = parseInt(msRaw.padEnd(3, '0').slice(0, 3), 10) / 1000;
        const timeInSeconds = minutes * 60 + seconds + milliseconds;
        const text = match[4].trim();

        if (text) {
          parsed.push({ time: timeInSeconds, text });
        }
      }
    }

    return parsed.sort((a, b) => a.time - b.time);
  }

  /**
   * Remove common noise from song titles (e.g. 'Official Video', 'Remastered', 'En Vivo', etc.)
   */
  function cleanTrackTitle(title) {
    return (title || '')
      .replace(/\s*[\(\[](?:official\s*(?:video|music\s*video|audio|lyric\s*video)?|video\s*oficial|audio\s*oficial|video|audio|remastered|explicit|hd|4k|en\s*vivo|en\s*directo|live)[^\)\]]*[\)\]]/gi, '')
      .replace(/\s*-\s*(?:official\s*video|audio|video|en\s*vivo|live)/gi, '')
      .trim();
  }

  /**
   * Separate primary artist from collaborations.
   */
  function extractArtists(artistString) {
    let base = artistString || '';
    if (base.includes('•')) base = base.split('•')[0].trim();
    if (base.includes('·')) base = base.split('·')[0].trim();

    const primary = base.split(/[,&]|\s+(?:y|and|feat\.?|ft\.?|x)\s+/i)[0].trim();
    return { full: base, primary: primary || base };
  }

  /**
   * Pick the best synced or plain lyrics from an LRCLIB result list for a given targetDuration.
   */
  function pickBestLyricsFromResults(results, targetDuration) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const withSynced = results.filter(item => item.syncedLyrics && item.syncedLyrics.trim().length > 0);
    if (withSynced.length > 0) {
      if (targetDuration && targetDuration > 0) {
        withSynced.sort((a, b) => Math.abs((a.duration || 0) - targetDuration) - Math.abs((b.duration || 0) - targetDuration));
      }
      return {
        type: 'synced',
        lyrics: withSynced[0].syncedLyrics,
        duration: withSynced[0].duration || 0,
        id: withSynced[0].id,
        source: 'lrclib'
      };
    }

    const withPlain = results.filter(item => item.plainLyrics && item.plainLyrics.trim().length > 0);
    if (withPlain.length > 0) {
      if (targetDuration && targetDuration > 0) {
        withPlain.sort((a, b) => Math.abs((a.duration || 0) - targetDuration) - Math.abs((b.duration || 0) - targetDuration));
      }
      return {
        type: 'plain',
        lyrics: withPlain[0].plainLyrics,
        duration: withPlain[0].duration || 0,
        id: withPlain[0].id,
        source: 'lrclib'
      };
    }

    return null;
  }

  /**
   * Fetch synced or plain lyrics from LRCLIB via Background Service Worker,
   * falling back to native YouTube Music DOM lyrics.
   */
  async function fetchLyrics(track, rawArtist, targetDuration) {
    const { full: fullArtist, primary: primaryArtist } = extractArtists(rawArtist);
    const cleanedTitle = cleanTrackTitle(track);
    const { getNativeYTMLyrics } = window.YTMLyrics.PlayerClock;

    const searchApi = (url) => {
      return new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'FETCH_API', url }, (res) => {
            if (chrome.runtime.lastError || !res || !res.success) {
              resolve(null);
            } else {
              resolve(res.data);
            }
          });
        } catch (e) {
          resolve(null);
        }
      });
    };

    const queryUrls = [
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(primaryArtist)}`,
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(fullArtist)}`,
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(primaryArtist)}`,
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanedTitle} ${primaryArtist}`)}`,
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanedTitle} ${fullArtist}`)}`
    ];

    const seen = new Set();
    for (const url of queryUrls) {
      if (seen.has(url)) continue;
      seen.add(url);

      const results = await searchApi(url);
      const match = pickBestLyricsFromResults(results, targetDuration);
      if (match) {
        return { match, rawResults: results };
      }
    }

    const nativeLyrics = getNativeYTMLyrics();
    if (nativeLyrics) {
      return {
        match: { type: 'plain', lyrics: nativeLyrics, source: 'ytm' },
        rawResults: null
      };
    }

    return { match: null, rawResults: null };
  }

  window.YTMLyrics.LyricsProvider = {
    parseLRC,
    cleanTrackTitle,
    extractArtists,
    pickBestLyricsFromResults,
    fetchLyrics
  };
})();
