/**
 * YTM Sync Lyrics - Main UI & Lifecycle Controller
 * Coordinates the modular subsystems:
 * - YTMLyrics.Phonetics (G2P & phonetic similarity)
 * - YTMLyrics.ForcedAlignment (DTW / Viterbi & dynamic re-alignment)
 * - YTMLyrics.PlayerClock (Player bar clock & DOM inspection)
 * - YTMLyrics.LyricsProvider (LRCLIB search & LRC parsing)
 */

(() => {
  'use strict';

  const {
    getActiveVideo,
    getAccuratePlaybackTime,
    getExpectedTrackDuration,
    getPlayerLyricsShelf,
    getNativeYTMLyrics
  } = window.YTMLyrics.PlayerClock;

  const {
    parseLRC,
    pickBestLyricsFromResults,
    fetchLyrics
  } = window.YTMLyrics.LyricsProvider;

  const {
    alignLyrics,
    realignFromUserAnchor
  } = window.YTMLyrics.ForcedAlignment;

  // --- Controller State ---
  let currentSongKey = '';
  let currentTitle = '';
  let currentArtist = '';
  let currentLyricsData = null;
  let currentLRCLIBResults = null;
  let currentASRSegments = [];
  let parsedLyrics = [];
  let isSynced = false;
  let isPredictedSync = false;
  let alignmentModeLabel = 'SYNCED';
  let lastPredictedDuration = 0;
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

  // --- UI Element References ---
  let embeddedContainerEl = null;
  let scrollBoxEl = null;
  let trackTitleEl = null;
  let statusBadgeEl = null;
  let toggleBtnEl = null;

  /**
   * Inject Main World page-bridge.js to extract YouTube's internal CTC/ASR captionTracks (json3).
   */
  function injectPageBridge() {
    if (document.getElementById('ytm-lyrics-page-bridge')) return;
    try {
      const script = document.createElement('script');
      script.id = 'ytm-lyrics-page-bridge';
      script.src = chrome.runtime.getURL('src/page-bridge.js');
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn('[YTM Sync Lyrics] Could not inject page bridge:', e);
    }
  }

  /**
   * Listen for CTC/ASR timedtext segments from page-bridge.js and run Forced Alignment if on plain lyrics.
   */
  window.addEventListener('ytm-lyrics-asr-data', (e) => {
    const detail = e.detail;
    if (!detail || !Array.isArray(detail.segments)) return;

    currentASRSegments = detail.segments;

    // If current track is using plain lyrics (AUTO-SYNC), upgrade immediately to DTW/Viterbi FORCED-ALIGN!
    if (isPredictedSync && currentLyricsData && currentLyricsData.type === 'plain' && currentASRSegments.length > 0) {
      const targetDur = getExpectedTrackDuration(awaitingVideoReset) || detail.duration || 180;
      const aligned = alignLyrics(currentLyricsData.lyrics, targetDur, currentASRSegments);
      if (aligned.lines.length > 0) {
        parsedLyrics = aligned.lines;
        alignmentModeLabel = aligned.mode;
        activeIndex = -2;
        updateBadgeDisplay();
      }
    }
  });

  /**
   * Update status badge label & style according to active mode and offset.
   */
  function updateBadgeDisplay() {
    if (!statusBadgeEl || !isSynced) return;

    statusBadgeEl.className = 'lyrics-status-badge ' + (
      !isPredictedSync ? 'synced' : (alignmentModeLabel === 'FORCED-ALIGN' ? 'forced' : 'predicted')
    );

    if (syncOffset === 0) {
      statusBadgeEl.textContent = isPredictedSync ? alignmentModeLabel : 'SYNCED';
      statusBadgeEl.title = isPredictedSync
        ? 'Click any lyric line when sung to anchor Forced Alignment to that exact second.'
        : '';
    } else {
      const sign = syncOffset > 0 ? '+' : '';
      const shortPrefix = !isPredictedSync ? 'SYNC' : (alignmentModeLabel === 'FORCED-ALIGN' ? 'ALIGN' : 'AUTO');
      statusBadgeEl.textContent = `${shortPrefix} (${sign}${syncOffset.toFixed(1)}s)`;
      statusBadgeEl.title = 'Click to reset offset to 0s';
    }
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
    const oldFloating = document.getElementById('lyrics-viewport');
    if (oldFloating) oldFloating.remove();

    const shelf = getPlayerLyricsShelf();
    if (!shelf) return false;

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

      shelf.prepend(container);

      embeddedContainerEl = container;
      scrollBoxEl = container.querySelector('#ytm-embedded-scroll-box');
      trackTitleEl = container.querySelector('.ytm-embedded-title');
      statusBadgeEl = container.querySelector('.lyrics-status-badge');

      const offsetDecBtn = container.querySelector('#lyrics-offset-dec');
      const offsetIncBtn = container.querySelector('#lyrics-offset-inc');

      offsetDecBtn.addEventListener('click', () => {
        syncOffset = Math.round((syncOffset - 0.5) * 10) / 10;
        activeIndex = -2;
        updateBadgeDisplay();
      });

      offsetIncBtn.addEventListener('click', () => {
        syncOffset = Math.round((syncOffset + 0.5) * 10) / 10;
        activeIndex = -2;
        updateBadgeDisplay();
      });

      statusBadgeEl.addEventListener('click', () => {
        if (syncOffset !== 0) {
          syncOffset = 0;
          activeIndex = -2;
          updateBadgeDisplay();
        }
      });

      const fontDecBtn = container.querySelector('#lyrics-font-dec');
      const fontIncBtn = container.querySelector('#lyrics-font-inc');
      fontDecBtn.addEventListener('click', () => setFontSize(currentFontSize - 2));
      fontIncBtn.addEventListener('click', () => setFontSize(currentFontSize + 2));

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
   * Render synced or forced-aligned lyrics into the embedded container.
   */
  function renderLyrics(data, title) {
    currentLyricsData = data;
    ensureEmbeddedContainer();
    if (!scrollBoxEl) return;

    if (trackTitleEl) trackTitleEl.textContent = title;

    if (!data) {
      isSynced = false;
      isPredictedSync = false;
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
      isSynced = true;
      isPredictedSync = true;
      const targetDur = getExpectedTrackDuration(awaitingVideoReset) || data.duration || 180;
      lastPredictedDuration = targetDur;

      const aligned = alignLyrics(data.lyrics, targetDur, currentASRSegments);
      parsedLyrics = aligned.lines;
      alignmentModeLabel = aligned.mode;
      scrollBoxEl.classList.remove('plain-mode');
      updateBadgeDisplay();
    } else {
      isSynced = true;
      isPredictedSync = false;
      alignmentModeLabel = 'SYNCED';
      scrollBoxEl.classList.remove('plain-mode');
      parsedLyrics = parseLRC(data.lyrics);
      updateBadgeDisplay();
    }

    if (parsedLyrics.length === 0) {
      scrollBoxEl.innerHTML = `
        <div class="lyrics-empty-state">
          <div class="lyrics-empty-icon">⚠️</div>
          <div class="lyrics-empty-title">Empty Lyrics</div>
          <div class="lyrics-empty-desc">The lyrics file contained no valid lines.</div>
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
      if (isPredictedSync) {
        p.title = 'Click when sung to anchor Forced Alignment here (or Alt+Click to seek audio)';
      }

      p.addEventListener('click', (e) => {
        if (isPredictedSync && !e.altKey) {
          // Viterbi Piecewise Forward Re-Alignment from this exact line and current playback second!
          const currentAccurate = getAccuratePlaybackTime();
          const dur = getExpectedTrackDuration(false) || lastPredictedDuration || 180;
          const realigned = realignFromUserAnchor(currentLyricsData.lyrics, index, currentAccurate, dur);
          if (realigned.length > 0) {
            parsedLyrics = realigned;
            syncOffset = 0;
            alignmentModeLabel = 'FORCED-ALIGN';
            isUserScrolling = false;
            activeIndex = -2;
            updateBadgeDisplay();
          }
          return;
        }

        // Standard Click-to-Seek in exact SYNCED mode (or Alt+Click in AUTO-SYNC mode)
        const video = getActiveVideo();
        if (video) {
          const currentAccurate = getAccuratePlaybackTime();
          const lineTargetTime = parsedLyrics[index]?.time ?? line.time;
          const delta = lineTargetTime - currentAccurate;
          if (Math.abs(video.currentTime - currentAccurate) <= 2.5) {
            video.currentTime = lineTargetTime;
          } else {
            video.currentTime = Math.max(0, video.currentTime + delta);
          }
        }
      });

      fragment.appendChild(p);
    });

    scrollBoxEl.innerHTML = '';
    scrollBoxEl.appendChild(fragment);
    scrollBoxEl.scrollTop = 0;

    const outerTabRenderer = document.querySelector('ytmusic-player-page #tab-renderer');
    if (outerTabRenderer) {
      outerTabRenderer.scrollTop = 0;
    }

    activeIndex = -2;
    startSyncLoop();
  }

  /**
   * Bind lifecycle events directly to the HTML5 <video> element.
   */
  function bindVideoListeners() {
    const video = getActiveVideo();
    if (!video || video === boundVideoEl) return;
    boundVideoEl = video;

    const handleStreamReady = () => {
      awaitingVideoReset = false;
      isUserScrolling = false;
      activeIndex = -2;

      if (scrollBoxEl) {
        scrollBoxEl.scrollTop = 0;
      }

      window.dispatchEvent(new CustomEvent('ytm-lyrics-request-asr'));
      checkTrackChange();

      const trueDuration = getExpectedTrackDuration(false);
      if (currentLRCLIBResults && trueDuration > 0) {
        const betterMatch = pickBestLyricsFromResults(currentLRCLIBResults, trueDuration);
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
   * Main 60fps sync loop updating active line and smooth native container scrolling.
   */
  function startSyncLoop() {
    if (syncAnimationFrameId) {
      cancelAnimationFrame(syncAnimationFrameId);
      syncAnimationFrameId = null;
    }

    bindVideoListeners();
    lastVideoTime = getAccuratePlaybackTime();

    function update() {
      if (!isSynced || parsedLyrics.length === 0) {
        return;
      }

      const liveScrollBox = document.getElementById('ytm-embedded-scroll-box') || scrollBoxEl;
      if (!liveScrollBox) {
        syncAnimationFrameId = requestAnimationFrame(update);
        return;
      }
      scrollBoxEl = liveScrollBox;

      const rawTime = getAccuratePlaybackTime();

      if (isPredictedSync && currentLyricsData && currentLyricsData.lyrics) {
        const liveDur = getExpectedTrackDuration(awaitingVideoReset);
        if (liveDur > 30 && Math.abs(liveDur - lastPredictedDuration) > 2) {
          lastPredictedDuration = liveDur;
          const aligned = alignLyrics(currentLyricsData.lyrics, liveDur, currentASRSegments);
          parsedLyrics = aligned.lines;
          alignmentModeLabel = aligned.mode;
          activeIndex = -2;
          updateBadgeDisplay();
        }
      }

      if (awaitingVideoReset) {
        if (rawTime < 4 || (Date.now() - trackChangeTimestamp > 3000)) {
          awaitingVideoReset = false;
          activeIndex = -2;
        }
      }

      if (rawTime < lastVideoTime - 2) {
        awaitingVideoReset = false;
        isUserScrolling = false;
        activeIndex = -2;
      }
      lastVideoTime = rawTime;

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

        for (let i = 0; i < domLines.length; i++) {
          if (i === activeIndex) {
            domLines[i].classList.add('active');
          } else {
            domLines[i].classList.remove('active');
          }
        }

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
    const expandBtn = document.querySelector('ytmusic-player-bar .image, ytmusic-player-bar #thumbnail');
    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage && playerPage.hasAttribute('player-page-open') === false && expandBtn) {
      expandBtn.click();
    }

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
      const shelf = getPlayerLyricsShelf();
      const container = document.getElementById('ytm-embedded-lyrics-container');
      if (shelf && (!container || container.parentNode !== shelf)) {
        renderLyrics(currentLyricsData, currentTitle);
      }
      return;
    }

    activeRequestId++;
    const thisRequestId = activeRequestId;

    currentSongKey = songKey;
    currentTitle = title;
    currentArtist = artist;
    currentLyricsData = null;
    currentLRCLIBResults = null;
    currentASRSegments = [];

    if (syncAnimationFrameId) {
      cancelAnimationFrame(syncAnimationFrameId);
      syncAnimationFrameId = null;
    }

    bindVideoListeners();
    window.dispatchEvent(new CustomEvent('ytm-lyrics-request-asr'));

    trackChangeTimestamp = Date.now();
    awaitingVideoReset = Boolean(getAccuratePlaybackTime() > 4);

    parsedLyrics = [];
    isSynced = false;
    isPredictedSync = false;
    activeIndex = -2;
    syncOffset = 0;
    isUserScrolling = false;

    injectToggleButton();
    renderLoadingState(title, artist);

    const targetDuration = getExpectedTrackDuration(awaitingVideoReset);
    const { match, rawResults } = await fetchLyrics(title, artist, targetDuration);

    if (thisRequestId !== activeRequestId) return;

    currentLRCLIBResults = rawResults;
    renderLyrics(match, title);
  }

  // --- Observer & Startup ---
  function initObserver() {
    injectPageBridge();

    chrome.storage.local.get(['lyricsFontSize'], (result) => {
      if (typeof result.lyricsFontSize === 'number') {
        setFontSize(result.lyricsFontSize, false);
      }
    });

    injectToggleButton();

    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        openYTMLyricsTab();
      }
    });

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
            renderLyrics(currentLyricsData, currentTitle);
          }
        } else if (!currentLyricsData && statusBadgeEl && statusBadgeEl.textContent === 'NO LYRICS') {
          const native = getNativeYTMLyrics();
          if (native) {
            currentLyricsData = { type: 'plain', lyrics: native, source: 'ytm' };
            renderLyrics(currentLyricsData, currentTitle);
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
