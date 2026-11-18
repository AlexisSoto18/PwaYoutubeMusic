/**
 * YTM Sync Lyrics - Player Clock & DOM Inspection Module
 * Provides accurate playback timestamps cross-checked against YouTube Music's player bar
 * (.time-info & #progress-bar) to prevent gapless MSE cumulative timeline drift.
 */

(() => {
  'use strict';

  window.YTMLyrics = window.YTMLyrics || {};

  let lastBarSec = -1;
  let lastBarSecTimestamp = 0;

  /**
   * Parse "mm:ss" or "hh:mm:ss" string into total seconds.
   */
  function parseTimeStringToSeconds(timeStr) {
    if (!timeStr) return -1;
    const parts = timeStr.trim().split(':').map(n => parseInt(n, 10));
    if (parts.some(isNaN)) return -1;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return -1;
  }

  /**
   * Read the authoritative current playback time and total duration displayed in YouTube Music's player bar.
   */
  function getPlayerBarTimeAndDuration() {
    const timeInfoEl = document.querySelector('ytmusic-player-bar .time-info');
    if (timeInfoEl && timeInfoEl.textContent) {
      const parts = timeInfoEl.textContent.split('/');
      if (parts.length === 2) {
        const current = parseTimeStringToSeconds(parts[0]);
        const total = parseTimeStringToSeconds(parts[1]);
        if (current >= 0 && total > 0) {
          return { current, total, valid: true };
        }
      }
    }

    const slider = document.querySelector('ytmusic-player-bar #progress-bar');
    if (slider) {
      const current = Number(slider.value ?? slider.getAttribute('value') ?? -1);
      const total = Number(slider.max ?? slider.getAttribute('aria-valuemax') ?? 0);
      if (current >= 0 && total > 0) {
        return { current, total, valid: true };
      }
    }

    return { current: 0, total: 0, valid: false };
  }

  /**
   * Locate the active HTML5 <video> element inside YouTube Music's player.
   */
  function getActiveVideo() {
    const videos = document.querySelectorAll('#movie_player video.html5-main-video, #movie_player video, ytmusic-player video, video');
    if (!videos || videos.length === 0) return null;

    for (const v of videos) {
      if (!v.paused && v.readyState >= 2) return v;
    }
    return videos[0];
  }

  /**
   * Get the accurate playback timestamp in seconds for the current track.
   */
  function getAccuratePlaybackTime() {
    const video = getActiveVideo();
    const bar = getPlayerBarTimeAndDuration();

    if (bar.valid) {
      if (bar.current !== lastBarSec) {
        lastBarSec = bar.current;
        lastBarSecTimestamp = performance.now();
      }

      if (video && !isNaN(video.currentTime) && Math.abs(video.currentTime - bar.current) <= 2.0) {
        return video.currentTime;
      }

      const isPlaying = video ? !video.paused : true;
      const subSecond = isPlaying
        ? Math.min(0.98, Math.max(0, (performance.now() - lastBarSecTimestamp) / 1000))
        : 0;
      return bar.current + subSecond;
    }

    return (video && !isNaN(video.currentTime)) ? video.currentTime : 0;
  }

  /**
   * Get the accurate duration of the current song.
   */
  function getExpectedTrackDuration(awaitingVideoReset = false) {
    const selectedQueueDurationEl = document.querySelector(
      'ytmusic-player-queue-item[selected] .duration, ' +
      'ytmusic-player-queue-item[play-button-state="playing"] .duration'
    );
    if (selectedQueueDurationEl && selectedQueueDurationEl.textContent) {
      const qSec = parseTimeStringToSeconds(selectedQueueDurationEl.textContent);
      if (qSec > 0) return qSec;
    }

    const bar = getPlayerBarTimeAndDuration();
    if (bar.valid && bar.total > 0 && !awaitingVideoReset) {
      return bar.total;
    }

    const video = getActiveVideo();
    if (video && !isNaN(video.duration) && video.duration > 0 && !awaitingVideoReset) {
      return video.duration;
    }

    return 0;
  }

  /**
   * Locate the active lyrics description shelf specifically inside ytmusic-player-page.
   */
  function getPlayerLyricsShelf() {
    const shelves = document.querySelectorAll(
      'ytmusic-player-page ytmusic-tab-renderer ytmusic-description-shelf-renderer, ' +
      'ytmusic-player-page ytmusic-description-shelf-renderer'
    );
    if (!shelves || shelves.length === 0) return null;

    for (const s of shelves) {
      if (s.offsetParent !== null) return s;
    }
    return shelves[0];
  }

  /**
   * Extract native lyrics directly from YouTube Music's player lyrics DOM.
   */
  function getNativeYTMLyrics() {
    const shelf = getPlayerLyricsShelf();
    if (!shelf) return null;

    const descriptions = shelf.querySelectorAll(
      'yt-formatted-string.non-expandable.description, yt-formatted-string.description, .description'
    );
    for (const el of descriptions) {
      if (el && el.textContent) {
        const text = el.textContent.trim();
        if (text.length > 20 && !text.toLowerCase().includes('no lyrics available')) {
          return text;
        }
      }
    }
    return null;
  }

  window.YTMLyrics.PlayerClock = {
    parseTimeStringToSeconds,
    getPlayerBarTimeAndDuration,
    getActiveVideo,
    getAccuratePlaybackTime,
    getExpectedTrackDuration,
    getPlayerLyricsShelf,
    getNativeYTMLyrics
  };
})();
