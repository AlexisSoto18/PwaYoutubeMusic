/**
 * YTM Sync Lyrics - Content Script
 * Native Embedded Synchronized Lyrics for YouTube Music Desktop & PWA.
 */

(() => {
  'use strict';

  // --- State ---
  let currentSongKey = '';
  let currentTitle = '';
  let currentArtist = '';
  let currentLyricsData = null;
  let currentLRCLIBResults = null;
  let parsedLyrics = [];
  let isSynced = false;
  let activeIndex = -2;
  let syncOffset = 0;
  let syncAnimationFrameId = null;
  let userScrollTimer = null;
  let isUserScrolling = false;
  let activeRequestId = 0;
  let lastVideoTime = 0;
  let currentFontSize = 26;
  let awaitingVideoReset = false;
  let trackChangeTimestamp = 0;
  let boundVideoEl = null;

  // --- Elements Cache ---
  let embeddedContainerEl = null;
  let scrollBoxEl = null;
  let trackTitleEl = null;
  let statusBadgeEl = null;
  let toggleBtnEl = null;

  /**
   * Parse LRC formatted text into structured array of objects.
   * Matches [mm:ss.xx] or [mm:ss.xxx] and sorts chronologically.
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
    return title
      .replace(/\s*[\(\[](?:official\s*(?:video|music\s*video|audio|lyric\s*video)?|video\s*oficial|audio\s*oficial|video|audio|remastered|explicit|hd|4k|en\s*vivo|en\s*directo|live)[^\)\]]*[\)\]]/gi, '')
      .replace(/\s*-\s*(?:official\s*video|audio|video|en\s*vivo|live)/gi, '')
      .trim();
  }

  /**
   * Separate primary artist from collaborations (e.g. "Artist 1, Artist 2 y Artist 3" -> primary: "Artist 1")
   */
  function extractArtists(artistString) {
    let base = artistString || '';
    if (base.includes('•')) base = base.split('•')[0].trim();
    if (base.includes('·')) base = base.split('·')[0].trim();

    // Primary artist before comma, &, y, and, ft., feat.
    const primary = base.split(/[,&]|\s+(?:y|and|feat\.?|ft\.?)\s+/i)[0].trim();
    return { full: base, primary: primary || base };
  }

  /**
   * Locate the active lyrics description shelf specifically inside ytmusic-player-page
   * (never match album/artist description shelves on background browse pages).
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
   * Fallback: Extract native lyrics directly from YouTube Music's player lyrics DOM.
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

  /**
   * Parse "mm:ss" or "hh:mm:ss" string into total seconds.
   */
  function parseTimeStringToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.trim().split(':').map(n => parseInt(n, 10));
    if (parts.some(isNaN)) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  /**
   * Get the accurate duration of the current song.
   * During automatic queue transitions, video.duration briefly holds the previous song's duration,
   * whereas the selected queue item already has the true duration of the new song.
   */
  function getExpectedTrackDuration() {
    // 1. Check the currently selected queue item (updates immediately on automatic transition)
    const selectedQueueDurationEl = document.querySelector(
      'ytmusic-player-queue-item[selected] .duration, ' +
      'ytmusic-player-queue-item[play-button-state="playing"] .duration'
    );
    if (selectedQueueDurationEl && selectedQueueDurationEl.textContent) {
      const qSec = parseTimeStringToSeconds(selectedQueueDurationEl.textContent);
      if (qSec > 0) return qSec;
    }

    // 2. Fallback to video.duration if valid and video is not still at the end of the previous track
    const video = document.querySelector('video');
    if (video && !isNaN(video.duration) && video.duration > 0 && !awaitingVideoReset) {
      return video.duration;
    }

    return 0;
  }

  /**
   * Pick the best synced or plain lyrics from an LRCLIB result list for a given targetDuration.
   */
  function pickBestLyricsFromResults(results, targetDuration) {
    if (!Array.isArray(results) || results.length === 0) return null;

    // 1. Prioritize synced lyrics
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

    // 2. Fallback to plain lyrics
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
   * Fetch synced or plain lyrics from LRCLIB using smart cascaded queries and duration matching.
   */
  async function fetchLyrics(track, rawArtist, targetDuration) {
    const { full: fullArtist, primary: primaryArtist } = extractArtists(rawArtist);
    const cleanedTitle = cleanTrackTitle(track);

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
          console.warn('[YTM Sync Lyrics] Message passing failed:', e);
          resolve(null);
        }
      });
    };

    // Cascade of query attempts in priority order:
    const queryUrls = [
      // Step 1: Cleaned title + primary artist (vital for songs with collaborations like "Los Principios")
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(primaryArtist)}`,
      // Step 2: Cleaned title + full artist
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(fullArtist)}`,
      // Step 3: Raw title + primary artist
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(primaryArtist)}`,
      // Step 4: Free-text search: cleaned title + primary artist
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanedTitle} ${primaryArtist}`)}`,
      // Step 5: Free-text search: cleaned title + full artist
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanedTitle} ${fullArtist}`)}`
    ];

    const seen = new Set();
    for (const url of queryUrls) {
      if (seen.has(url)) continue;
      seen.add(url);

      const results = await searchApi(url);
      const match = pickBestLyricsFromResults(results, targetDuration);
      if (match) {
        currentLRCLIBResults = results;
        return match;
      }
    }

    // Step 6: Native YouTube Music lyrics fallback from DOM
    const nativeLyrics = getNativeYTMLyrics();
    if (nativeLyrics) {
      return { type: 'plain', lyrics: nativeLyrics, source: 'ytm' };
    }

    return null;
  }

  /**
   * Set font size with persistence.
   */
  function setFontSize(size, save = true) {
    currentFontSize = Math.max(16, Math.min(44, size));
    if (embeddedContainerEl) {
      embeddedContainerEl.style.setProperty('--ytm-lyric-font-size', `${currentFontSize}px`);
    }
    if (save) {
      chrome.storage.local.set({ lyricsFontSize: currentFontSize });
    }
  }

  /**
   * Mount or update embedded lyrics container inside YouTube Music's native player lyrics shelf.
   */
  function ensureEmbeddedContainer() {
    // Clean up any old floating viewport if still in DOM
    const oldFloating = document.getElementById('lyrics-viewport');
    if (oldFloating) oldFloating.remove();

    const shelf = getPlayerLyricsShelf();
    if (!shelf) return false;

    // Mark this specific shelf as active and hide all native description elements
    shelf.classList.add('ytm-lyrics-active-shelf');
    shelf.querySelectorAll('.description').forEach((el) => {
      el.style.setProperty('display', 'none', 'important');
    });

    let container = document.getElementById('ytm-embedded-lyrics-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'ytm-embedded-lyrics-container';
      container.style.setProperty('--ytm-lyric-font-size', `${currentFontSize}px`);

      container.innerHTML = `
        <div class="ytm-embedded-header">
          <div class="ytm-embedded-meta">
            <span class="ytm-embedded-title">${currentTitle || 'Lyrics'}</span>
          </div>
          <div class="ytm-embedded-actions">
            <button class="lyrics-action-btn" id="lyrics-offset-dec" title="Delay lyrics (-0.5s)">-0.5s</button>
            <button class="lyrics-action-btn" id="lyrics-offset-inc" title="Advance lyrics (+0.5s)">+0.5s</button>
            <button class="lyrics-action-btn" id="lyrics-font-dec" title="Decrease font size">A-</button>
            <button class="lyrics-action-btn" id="lyrics-font-inc" title="Increase font size">A+</button>
            <span class="lyrics-status-badge">STANDBY</span>
          </div>
        </div>
        <div id="ytm-embedded-scroll-box"></div>
      `;

      // Always prepend directly as a top-level child of shelf (never inside a hidden expandable-description wrapper)
      shelf.prepend(container);

      embeddedContainerEl = container;
      scrollBoxEl = container.querySelector('#ytm-embedded-scroll-box');
      trackTitleEl = container.querySelector('.ytm-embedded-title');
      statusBadgeEl = container.querySelector('.lyrics-status-badge');

      // Wire offset buttons
      const offsetDecBtn = container.querySelector('#lyrics-offset-dec');
      const offsetIncBtn = container.querySelector('#lyrics-offset-inc');

      const updateOffsetBadge = () => {
        if (!isSynced || !statusBadgeEl) return;
        if (syncOffset === 0) {
          statusBadgeEl.textContent = 'SYNCED';
          statusBadgeEl.title = '';
        } else {
          const sign = syncOffset > 0 ? '+' : '';
          statusBadgeEl.textContent = `${sign}${syncOffset.toFixed(1)}s`;
          statusBadgeEl.title = 'Click to reset offset to 0s';
        }
      };

      offsetDecBtn.addEventListener('click', () => {
        syncOffset = Math.round((syncOffset - 0.5) * 10) / 10;
        updateOffsetBadge();
      });

      offsetIncBtn.addEventListener('click', () => {
        syncOffset = Math.round((syncOffset + 0.5) * 10) / 10;
        updateOffsetBadge();
      });

      statusBadgeEl.addEventListener('click', () => {
        if (syncOffset !== 0) {
          syncOffset = 0;
          updateOffsetBadge();
        }
      });

      // Wire font size buttons
      const fontDecBtn = container.querySelector('#lyrics-font-dec');
      const fontIncBtn = container.querySelector('#lyrics-font-inc');
      fontDecBtn.addEventListener('click', () => setFontSize(currentFontSize - 2));
      fontIncBtn.addEventListener('click', () => setFontSize(currentFontSize + 2));

      // Handle manual scrolling: pause auto-scroll for 3.5 seconds
      const handleUserManualScroll = () => {
        isUserScrolling = true;
        clearTimeout(userScrollTimer);
        userScrollTimer = setTimeout(() => {
          isUserScrolling = false;
        }, 3500);
      };

      scrollBoxEl.addEventListener('wheel', handleUserManualScroll, { passive: true });
      scrollBoxEl.addEventListener('touchstart', handleUserManualScroll, { passive: true });
    } else {
      // Ensure container is a direct child of the current active player shelf
      if (container.parentNode !== shelf) {
        shelf.prepend(container);
      }
      embeddedContainerEl = container;
      scrollBoxEl = container.querySelector('#ytm-embedded-scroll-box');
      trackTitleEl = container.querySelector('.ytm-embedded-title');
      statusBadgeEl = container.querySelector('.lyrics-status-badge');
    }

    return true;
  }

  /**
   * Display loading/searching message in the embedded box.
   */
  function renderLoadingState(title, artist) {
    ensureEmbeddedContainer();
    if (!scrollBoxEl) return;

    if (trackTitleEl) trackTitleEl.textContent = title;
    if (statusBadgeEl) {
      statusBadgeEl.textContent = 'SEARCHING...';
      statusBadgeEl.className = 'lyrics-status-badge';
    }

    scrollBoxEl.classList.remove('plain-mode');
    scrollBoxEl.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">⏳</div>
        <div class="lyrics-empty-title">Searching Lyrics</div>
        <div class="lyrics-empty-desc">Looking up lyrics for ${title} by ${artist}...</div>
      </div>
    `;
    scrollBoxEl.scrollTop = 0;
  }

  /**
   * Render synced or plain lyrics into the embedded container.
   */
  function renderLyrics(data, title, artist) {
    currentLyricsData = data;
    ensureEmbeddedContainer();
    if (!scrollBoxEl) return;

    if (trackTitleEl) trackTitleEl.textContent = title;

    if (!data) {
      isSynced = false;
      parsedLyrics = [];
      activeIndex = -1;
      if (statusBadgeEl) {
        statusBadgeEl.textContent = 'NO LYRICS';
        statusBadgeEl.className = 'lyrics-status-badge';
      }
      scrollBoxEl.classList.remove('plain-mode');
      scrollBoxEl.innerHTML = `
        <div class="lyrics-empty-state">
          <div class="lyrics-empty-icon">🔍</div>
          <div class="lyrics-empty-title">No Lyrics Found</div>
          <div class="lyrics-empty-desc">No synchronized or plain lyrics found for this track.</div>
        </div>
      `;
      scrollBoxEl.scrollTop = 0;
      return;
    }

    if (data.type === 'plain') {
      isSynced = false;
      parsedLyrics = [];
      activeIndex = -1;
      if (statusBadgeEl) {
        statusBadgeEl.textContent = data.source === 'ytm' ? 'YTM PLAIN' : 'PLAIN';
        statusBadgeEl.className = 'lyrics-status-badge';
      }
      scrollBoxEl.classList.add('plain-mode');

      const lines = data.lyrics.split('\n');
      scrollBoxEl.innerHTML = lines
        .map(line => `<p class="lyric-line">${line || '&nbsp;'}</p>`)
        .join('');
      scrollBoxEl.scrollTop = 0;
      return;
    }

    // Synced Lyrics
    isSynced = true;
    if (statusBadgeEl) {
      statusBadgeEl.textContent = 'SYNCED';
      statusBadgeEl.className = 'lyrics-status-badge synced';
    }
    scrollBoxEl.classList.remove('plain-mode');

    parsedLyrics = parseLRC(data.lyrics);

    if (parsedLyrics.length === 0) {
      scrollBoxEl.innerHTML = `
        <div class="lyrics-empty-state">
          <div class="lyrics-empty-icon">⚠️</div>
          <div class="lyrics-empty-title">Empty Lyrics</div>
          <div class="lyrics-empty-desc">The lyrics file contained no valid timestamped lines.</div>
        </div>
      `;
      return;
    }

    const fragment = document.createDocumentFragment();
    parsedLyrics.forEach((line, index) => {
      const p = document.createElement('p');
      p.className = 'lyric-line';
      p.dataset.index = index;
      p.textContent = line.text;

      // Interactive Click to Seek
      p.addEventListener('click', () => {
        const video = document.querySelector('video');
        if (video) {
          video.currentTime = line.time;
        }
      });

      fragment.appendChild(p);
    });

    scrollBoxEl.innerHTML = '';
    scrollBoxEl.appendChild(fragment);
    scrollBoxEl.scrollTop = 0;

    // Also reset outer tab-renderer scroll position if user had scrolled the outer tab
    const outerTabRenderer = document.querySelector('ytmusic-player-page #tab-renderer');
    if (outerTabRenderer) {
      outerTabRenderer.scrollTop = 0;
    }

    // Use -2 sentinel so the very first frame (even when currentIndex is -1 during intro) forces a clean UI sync
    activeIndex = -2;

    startSyncLoop();
  }

  /**
   * Bind lifecycle events directly to the HTML5 <video> element to catch automatic track transitions
   * and update duration matching when the new stream metadata loads.
   */
  function bindVideoListeners() {
    const video = document.querySelector('video');
    if (!video || video === boundVideoEl) return;
    boundVideoEl = video;

    const handleStreamReady = () => {
      awaitingVideoReset = false;
      isUserScrolling = false;
      activeIndex = -2;

      if (scrollBoxEl) {
        scrollBoxEl.scrollTop = 0;
      }

      // Re-verify track metadata in case player bar updated at the same time
      checkTrackChange();

      // If LRCLIB returned multiple versions, re-pick using the now-accurate video.duration
      if (currentLRCLIBResults && !isNaN(video.duration) && video.duration > 0) {
        const betterMatch = pickBestLyricsFromResults(currentLRCLIBResults, video.duration);
        if (betterMatch && currentLyricsData && betterMatch.id !== currentLyricsData.id) {
          renderLyrics(betterMatch, currentTitle, currentArtist);
        }
      }
    };

    video.addEventListener('loadedmetadata', handleStreamReady);
    video.addEventListener('durationchange', handleStreamReady);
    video.addEventListener('ended', () => {
      awaitingVideoReset = true;
      trackChangeTimestamp = Date.now();
      activeIndex = -2;
      if (scrollBoxEl) {
        scrollBoxEl.scrollTop = 0;
      }
    });
  }

  /**
   * Main sync loop updating active line and smooth native container scrolling.
   */
  function startSyncLoop() {
    if (syncAnimationFrameId) {
      cancelAnimationFrame(syncAnimationFrameId);
      syncAnimationFrameId = null;
    }

    const video = document.querySelector('video');
    if (!video) return;

    bindVideoListeners();
    lastVideoTime = video.currentTime;

    function update() {
      if (!isSynced || parsedLyrics.length === 0 || !scrollBoxEl) {
        return;
      }

      const rawTime = video.currentTime;

      // Clear awaitingVideoReset once the new song stream resets currentTime near 0 (or timeout passes)
      if (awaitingVideoReset) {
        if (rawTime < 3 || (Date.now() - trackChangeTimestamp > 3500)) {
          awaitingVideoReset = false;
          activeIndex = -2;
        }
      }

      // Song loop/rewind detection: if video jumped back > 2s, force sentinel -2 so active classes & scroll reset
      if (rawTime < lastVideoTime - 2) {
        awaitingVideoReset = false;
        isUserScrolling = false;
        activeIndex = -2;
      }
      lastVideoTime = rawTime;

      // If the player is still holding the end timestamp of the previous song while loading the next track,
      // treat time as 0 so it never jumps to the bottom of the new lyrics!
      const effectiveRawTime = (awaitingVideoReset && rawTime > 5) ? 0 : rawTime;
      const currentTime = effectiveRawTime + syncOffset;
      let currentIndex = -1;

      for (let i = 0; i < parsedLyrics.length; i++) {
        if (currentTime >= parsedLyrics[i].time) {
          currentIndex = i;
        } else {
          break;
        }
      }

      if (currentIndex !== activeIndex) {
        activeIndex = currentIndex;
        const domLines = scrollBoxEl.getElementsByClassName('lyric-line');

        // Update active class
        for (let i = 0; i < domLines.length; i++) {
          if (i === activeIndex) {
            domLines[i].classList.add('active');
          } else {
            domLines[i].classList.remove('active');
          }
        }

        // Native smooth container scrolling (only if user is not actively scrolling manually)
        if (!isUserScrolling) {
          if (activeIndex !== -1 && domLines[activeIndex]) {
            const activeLine = domLines[activeIndex];
            const targetAnchor = scrollBoxEl.clientHeight * 0.22;
            const lineTop = activeLine.offsetTop;
            const targetScrollTop = Math.max(0, lineTop - targetAnchor);

            scrollBoxEl.scrollTo({
              top: targetScrollTop,
              behavior: 'smooth'
            });
          } else if (activeIndex === -1) {
            scrollBoxEl.scrollTo({
              top: 0,
              behavior: 'smooth'
            });
          }
        }
      }

      syncAnimationFrameId = requestAnimationFrame(update);
    }

    syncAnimationFrameId = requestAnimationFrame(update);
  }

  /**
   * Switch YouTube Music to native LETRA tab when bottom shortcut button is clicked.
   */
  function openYTMLyricsTab() {
    // 1. Expand player page if not already expanded
    const expandBtn = document.querySelector('ytmusic-player-bar .image, ytmusic-player-bar #thumbnail');
    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage && playerPage.hasAttribute('player-page-open') === false && expandBtn) {
      expandBtn.click();
    }

    // 2. Click the LETRA (Lyrics) tab
    setTimeout(() => {
      const tabs = document.querySelectorAll('ytmusic-player-page tp-yt-paper-tab');
      if (tabs && tabs.length >= 2) {
        tabs[1].click();
      }
    }, 100);
  }

  /**
   * Inject shortcut button into YouTube Music player bar.
   */
  function injectToggleButton() {
    if (document.getElementById('ytm-sync-lyrics-toggle')) return;

    const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons');
    if (!rightControls) return;

    toggleBtnEl = document.createElement('button');
    toggleBtnEl.id = 'ytm-sync-lyrics-toggle';
    toggleBtnEl.title = 'Open Synced Lyrics (Alt+L)';
    toggleBtnEl.setAttribute('aria-label', 'Open Synced Lyrics');
    toggleBtnEl.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6zm-2 16c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
      </svg>
    `;

    toggleBtnEl.addEventListener('click', openYTMLyricsTab);
    rightControls.prepend(toggleBtnEl);
  }

  /**
   * Inspect player bar and detect song changes with concurrency protection.
   */
  async function checkTrackChange() {
    const titleEl = document.querySelector('ytmusic-player-bar yt-formatted-string.title, ytmusic-player-bar .title');
    const artistEl = document.querySelector('ytmusic-player-bar span.subtitle yt-formatted-string, ytmusic-player-bar .byline, ytmusic-player-bar .subtitle');

    if (!titleEl || !artistEl) return;

    const title = titleEl.textContent?.trim() || '';
    let artist = artistEl.textContent?.trim() || '';

    if (artist.includes('•')) {
      artist = artist.split('•')[0].trim();
    } else if (artist.includes('·')) {
      artist = artist.split('·')[0].trim();
    }

    if (!title || !artist) return;

    const songKey = `${title}:::${artist}`;
    if (songKey === currentSongKey) {
      // Re-mount if player shelf was re-created or switched in DOM
      const shelf = getPlayerLyricsShelf();
      const container = document.getElementById('ytm-embedded-lyrics-container');
      if (shelf && (!container || container.parentNode !== shelf)) {
        renderLyrics(currentLyricsData, currentTitle, currentArtist);
      }
      return;
    }

    // --- Song Transition: Reset state immediately ---
    activeRequestId++;
    const thisRequestId = activeRequestId;

    currentSongKey = songKey;
    currentTitle = title;
    currentArtist = artist;
    currentLyricsData = null;
    currentLRCLIBResults = null;

    if (syncAnimationFrameId) {
      cancelAnimationFrame(syncAnimationFrameId);
      syncAnimationFrameId = null;
    }

    const video = document.querySelector('video');
    bindVideoListeners();

    // If video.currentTime is still > 4s when the title changes, <video> hasn't reset to 0s for the new track yet!
    trackChangeTimestamp = Date.now();
    awaitingVideoReset = Boolean(video && video.currentTime > 4);

    parsedLyrics = [];
    isSynced = false;
    activeIndex = -2;
    syncOffset = 0;
    isUserScrolling = false;

    injectToggleButton();
    renderLoadingState(title, artist);

    // Fetch lyrics with accurate duration from selected queue item or video
    const targetDuration = getExpectedTrackDuration();
    const data = await fetchLyrics(title, artist, targetDuration);

    // Stale request guard: if song changed while fetching, discard this result!
    if (thisRequestId !== activeRequestId) return;

    renderLyrics(data, title, artist);
  }

  // --- Observer & Startup ---
  function initObserver() {
    // Restore saved font size preference
    chrome.storage.local.get(['lyricsFontSize'], (result) => {
      if (typeof result.lyricsFontSize === 'number') {
        setFontSize(result.lyricsFontSize, false);
      }
    });

    injectToggleButton();

    // Keyboard shortcut (Alt + L) to open native lyrics tab
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        openYTMLyricsTab();
      }
    });

    // Observe player bar for track changes
    const playerBar = document.querySelector('ytmusic-player-bar');
    if (playerBar) {
      const observer = new MutationObserver(() => {
        checkTrackChange();
        injectToggleButton();
      });

      observer.observe(playerBar, {
        childList: true,
        subtree: true,
        characterData: true
      });

      checkTrackChange();
    } else {
      const docObserver = new MutationObserver((_, obs) => {
        const bar = document.querySelector('ytmusic-player-bar');
        if (bar) {
          obs.disconnect();
          initObserver();
        }
      });

      docObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Observe YTM tab content to inject embedded container when LETRA tab is open
    const tabObserver = new MutationObserver(() => {
      if (!currentSongKey) {
        checkTrackChange();
      }

      const shelf = getPlayerLyricsShelf();
      if (shelf) {
        const container = document.getElementById('ytm-embedded-lyrics-container');
        if (!container || container.parentNode !== shelf) {
          if (currentSongKey) {
            if (!currentLyricsData) {
              const native = getNativeYTMLyrics();
              if (native) {
                currentLyricsData = { type: 'plain', lyrics: native, source: 'ytm' };
              }
            }
            renderLyrics(currentLyricsData, currentTitle, currentArtist);
          }
        } else if (!currentLyricsData && statusBadgeEl && statusBadgeEl.textContent === 'NO LYRICS') {
          const native = getNativeYTMLyrics();
          if (native) {
            currentLyricsData = { type: 'plain', lyrics: native, source: 'ytm' };
            renderLyrics(currentLyricsData, currentTitle, currentArtist);
          }
        }
      }
    });

    tabObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }
})();
