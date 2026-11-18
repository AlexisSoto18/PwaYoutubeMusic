/**
 * YTM Sync Lyrics - Content Script
 * Beautiful glassmorphism synchronized lyrics for YouTube Music Desktop / PWA.
 */

(() => {
  'use strict';

  // --- State ---
  let currentSongKey = '';
  let parsedLyrics = [];
  let isSynced = false;
  let activeIndex = -1;
  let syncOffset = 0;
  let syncAnimationFrameId = null;
  let userScrollingTimer = null;
  let isUserScrolling = false;
  let isPanelVisible = true;

  // --- Elements Cache ---
  let viewportEl = null;
  let scrollContainerEl = null;
  let wrapperEl = null;
  let trackTitleEl = null;
  let trackArtistEl = null;
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
   * Fallback: Extract native lyrics directly from YouTube Music's DOM if open or loaded.
   */
  function getNativeYTMLyrics() {
    const el = document.querySelector(
      'ytmusic-description-shelf-renderer yt-formatted-string.description, ' +
      'ytmusic-description-shelf-renderer .description, ' +
      'ytmusic-tab-renderer[page-type*="LYRICS"] .description'
    );
    if (el && el.textContent) {
      const text = el.textContent.trim();
      if (text.length > 20 && !text.toLowerCase().includes('no lyrics available')) {
        return text;
      }
    }
    return null;
  }

  /**
   * Fetch synced or plain lyrics from LRCLIB using smart cascaded queries and duration matching.
   */
  async function fetchLyrics(track, rawArtist, targetDuration) {
    const { full: fullArtist, primary: primaryArtist } = extractArtists(rawArtist);
    const cleanedTitle = cleanTrackTitle(track);

    const searchApi = async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch (e) {
        console.warn('[YTM Sync Lyrics] Search request failed:', e);
        return null;
      }
    };

    const pickBestLyrics = (results) => {
      if (!Array.isArray(results) || results.length === 0) return null;

      // 1. Prioritize synced lyrics
      const withSynced = results.filter(item => item.syncedLyrics && item.syncedLyrics.trim().length > 0);
      if (withSynced.length > 0) {
        if (targetDuration && targetDuration > 0) {
          withSynced.sort((a, b) => Math.abs((a.duration || 0) - targetDuration) - Math.abs((b.duration || 0) - targetDuration));
        }
        return { type: 'synced', lyrics: withSynced[0].syncedLyrics, source: 'lrclib' };
      }

      // 2. Fallback to plain lyrics
      const withPlain = results.filter(item => item.plainLyrics && item.plainLyrics.trim().length > 0);
      if (withPlain.length > 0) {
        if (targetDuration && targetDuration > 0) {
          withPlain.sort((a, b) => Math.abs((a.duration || 0) - targetDuration) - Math.abs((b.duration || 0) - targetDuration));
        }
        return { type: 'plain', lyrics: withPlain[0].plainLyrics, source: 'lrclib' };
      }

      return null;
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
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanedTitle} ${fullArtist}`)}`,
      // Step 6: Free-text search: cleaned title only
      `https://lrclib.net/api/search?q=${encodeURIComponent(cleanedTitle)}`
    ];

    const seen = new Set();
    for (const url of queryUrls) {
      if (seen.has(url)) continue;
      seen.add(url);

      const results = await searchApi(url);
      const match = pickBestLyrics(results);
      if (match) return match;
    }

    // Step 7: Native YouTube Music lyrics fallback from DOM
    const nativeLyrics = getNativeYTMLyrics();
    if (nativeLyrics) {
      return { type: 'plain', lyrics: nativeLyrics, source: 'ytm' };
    }

    return null;
  }

  /**
   * Extract dominant RGB color from the album artwork without CORS canvas taint.
   */
  async function extractDominantColor(imageUrl) {
    if (!imageUrl) return null;

    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(blobUrl);
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          canvas.width = 48;
          canvas.height = 48;
          ctx.drawImage(img, 0, 0, 48, 48);

          try {
            const { data } = ctx.getImageData(0, 0, 48, 48);
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < data.length; i += 16) {
              r += data[i];
              g += data[i + 1];
              b += data[i + 2];
              count++;
            }

            if (count > 0) {
              r = Math.min(255, Math.floor((r / count) * 1.1));
              g = Math.min(255, Math.floor((g / count) * 1.1));
              b = Math.min(255, Math.floor((b / count) * 1.1));
              resolve({ r, g, b });
              return;
            }
          } catch (e) {
            console.warn('[YTM Sync Lyrics] Error reading canvas pixels:', e);
          }
          resolve(null);
        };

        img.onerror = () => {
          URL.revokeObjectURL(blobUrl);
          resolve(null);
        };

        img.src = blobUrl;
      });
    } catch (err) {
      console.warn('[YTM Sync Lyrics] Dominant color extraction failed:', err);
      return null;
    }
  }

  /**
   * Apply dynamic background theme based on artwork dominant color.
   */
  function applyColorTheme(color) {
    if (!viewportEl) return;

    if (color) {
      const { r, g, b } = color;
      const bg = `rgba(${r}, ${g}, ${b}, 0.42)`;
      const glow = `rgba(${Math.max(0, r - 50)}, ${Math.max(0, g - 50)}, ${Math.max(0, b - 50)}, 0.55)`;
      viewportEl.style.setProperty('--ytm-lyrics-bg', bg);
      viewportEl.style.setProperty('--ytm-lyrics-glow', glow);
    } else {
      viewportEl.style.removeProperty('--ytm-lyrics-bg');
      viewportEl.style.removeProperty('--ytm-lyrics-glow');
    }
  }

  /**
   * Create and mount the UI panel in the DOM.
   */
  function initLyricsUI() {
    if (document.getElementById('lyrics-viewport')) return;

    viewportEl = document.createElement('div');
    viewportEl.id = 'lyrics-viewport';

    viewportEl.innerHTML = `
      <div class="lyrics-header">
        <div class="lyrics-drag-handle"></div>
        <div class="lyrics-header-row">
          <div class="lyrics-meta">
            <span class="lyrics-track-title">Waiting for music...</span>
            <span class="lyrics-track-artist">YouTube Music</span>
          </div>
          <div class="lyrics-header-actions">
            <button class="lyrics-action-btn" id="lyrics-offset-dec" title="Delay lyrics (-0.5s)">-0.5s</button>
            <button class="lyrics-action-btn" id="lyrics-offset-inc" title="Advance lyrics (+0.5s)">+0.5s</button>
            <button class="lyrics-action-btn" id="lyrics-font-dec" title="Decrease font size">A-</button>
            <button class="lyrics-action-btn" id="lyrics-font-inc" title="Increase font size">A+</button>
            <span class="lyrics-status-badge">STANDBY</span>
            <button class="lyrics-close-btn" title="Close lyrics panel (Alt+L)">&times;</button>
          </div>
        </div>
      </div>
      <div class="lyrics-scroll-container">
        <div id="lyrics-wrapper"></div>
      </div>
    `;

    document.body.appendChild(viewportEl);

    scrollContainerEl = viewportEl.querySelector('.lyrics-scroll-container');
    wrapperEl = document.getElementById('lyrics-wrapper');
    trackTitleEl = viewportEl.querySelector('.lyrics-track-title');
    trackArtistEl = viewportEl.querySelector('.lyrics-track-artist');
    statusBadgeEl = viewportEl.querySelector('.lyrics-status-badge');

    // Close button
    const closeBtn = viewportEl.querySelector('.lyrics-close-btn');
    closeBtn.addEventListener('click', () => togglePanelVisibility(false));

    // Sync offset calibration controls
    const updateSyncOffsetBadge = () => {
      if (!isSynced) return;
      if (syncOffset === 0) {
        statusBadgeEl.textContent = 'SYNCED';
        statusBadgeEl.title = '';
      } else {
        const sign = syncOffset > 0 ? '+' : '';
        statusBadgeEl.textContent = `${sign}${syncOffset.toFixed(1)}s`;
        statusBadgeEl.title = 'Click to reset offset to 0s';
      }
    };

    const offsetDecBtn = viewportEl.querySelector('#lyrics-offset-dec');
    const offsetIncBtn = viewportEl.querySelector('#lyrics-offset-inc');

    offsetDecBtn.addEventListener('click', () => {
      syncOffset = Math.round((syncOffset - 0.5) * 10) / 10;
      updateSyncOffsetBadge();
    });

    offsetIncBtn.addEventListener('click', () => {
      syncOffset = Math.round((syncOffset + 0.5) * 10) / 10;
      updateSyncOffsetBadge();
    });

    statusBadgeEl.addEventListener('click', () => {
      if (syncOffset !== 0) {
        syncOffset = 0;
        updateSyncOffsetBadge();
      }
    });

    // Font size controls
    let currentFontSize = 30;
    const setFontSize = (size, save = true) => {
      currentFontSize = Math.max(18, Math.min(46, size));
      viewportEl.style.setProperty('--ytm-lyric-font-size', `${currentFontSize}px`);
      if (save) {
        chrome.storage.local.set({ lyricsFontSize: currentFontSize });
      }
    };

    const fontDecBtn = viewportEl.querySelector('#lyrics-font-dec');
    const fontIncBtn = viewportEl.querySelector('#lyrics-font-inc');
    fontDecBtn.addEventListener('click', () => setFontSize(currentFontSize - 2));
    fontIncBtn.addEventListener('click', () => setFontSize(currentFontSize + 2));

    // Enable drag & drop on header
    const headerEl = viewportEl.querySelector('.lyrics-header');
    setupPanelDragging(viewportEl, headerEl);

    // Handle user manual scroll: temporarily disable auto-scroll snap
    scrollContainerEl.addEventListener('wheel', () => {
      isUserScrolling = true;
      clearTimeout(userScrollingTimer);
      userScrollingTimer = setTimeout(() => {
        isUserScrolling = false;
      }, 3500);
    }, { passive: true });

    // Restore saved visibility, position, and font size preferences
    chrome.storage.local.get(['lyricsPanelVisible', 'lyricsPosition', 'lyricsFontSize'], (result) => {
      if (typeof result.lyricsPanelVisible === 'boolean') {
        togglePanelVisibility(result.lyricsPanelVisible, false);
      }
      if (result.lyricsPosition && viewportEl) {
        viewportEl.style.right = 'auto';
        viewportEl.style.left = result.lyricsPosition.left;
        viewportEl.style.top = result.lyricsPosition.top;
      }
      if (typeof result.lyricsFontSize === 'number') {
        setFontSize(result.lyricsFontSize, false);
      }
    });

    // Keyboard shortcut (Alt + L) to toggle lyrics
    window.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        togglePanelVisibility(!isPanelVisible);
      }
    });
  }

  /**
   * Toggle panel visibility and persist state.
   */
  function togglePanelVisibility(show, save = true) {
    isPanelVisible = show;
    if (viewportEl) {
      if (show) {
        viewportEl.classList.remove('lyrics-hidden');
      } else {
        viewportEl.classList.add('lyrics-hidden');
      }
    }

    if (toggleBtnEl) {
      toggleBtnEl.classList.toggle('active', show);
    }

    if (save) {
      chrome.storage.local.set({ lyricsPanelVisible: show });
    }
  }

  /**
   * Configure drag & drop mechanics and position persistence.
   */
  function setupPanelDragging(panel, handle) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;

      isDragging = true;
      handle.classList.add('grabbing');

      const rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = rect.left;
      initialTop = rect.top;

      panel.style.right = 'auto';
      panel.style.left = `${initialLeft}px`;
      panel.style.top = `${initialTop}px`;
      panel.style.transition = 'opacity 0.35s cubic-bezier(0.2, 0.8, 0.2, 1), background 0.8s ease, box-shadow 0.8s ease';

      handle.setPointerCapture?.(e.pointerId);
    });

    window.addEventListener('pointermove', (e) => {
      if (!isDragging) return;

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;

      let newLeft = initialLeft + deltaX;
      let newTop = initialTop + deltaY;

      const maxLeft = Math.max(10, window.innerWidth - panel.offsetWidth - 10);
      const maxTop = Math.max(10, window.innerHeight - panel.offsetHeight - 10);

      newLeft = Math.max(10, Math.min(newLeft, maxLeft));
      newTop = Math.max(10, Math.min(newTop, maxTop));

      panel.style.left = `${newLeft}px`;
      panel.style.top = `${newTop}px`;
    });

    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('grabbing');
      panel.style.transition = '';

      chrome.storage.local.set({
        lyricsPosition: {
          left: panel.style.left,
          top: panel.style.top
        }
      });
    };

    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);

    // Double-click on header to snap back to default top-right anchor
    handle.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      panel.style.left = '';
      panel.style.top = '9vh';
      panel.style.right = '32px';
      chrome.storage.local.remove('lyricsPosition');
    });
  }

  /**
   * Inject toggle button into YouTube Music player bar.
   */
  function injectToggleButton() {
    if (document.getElementById('ytm-sync-lyrics-toggle')) return;

    const rightControls = document.querySelector('ytmusic-player-bar .right-controls-buttons');
    if (!rightControls) return;

    toggleBtnEl = document.createElement('button');
    toggleBtnEl.id = 'ytm-sync-lyrics-toggle';
    toggleBtnEl.title = 'Toggle Glass Lyrics (Alt+L)';
    toggleBtnEl.setAttribute('aria-label', 'Toggle Glass Lyrics');
    toggleBtnEl.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6zm-2 16c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
      </svg>
    `;

    if (isPanelVisible) toggleBtnEl.classList.add('active');

    toggleBtnEl.addEventListener('click', () => {
      togglePanelVisibility(!isPanelVisible);
    });

    rightControls.prepend(toggleBtnEl);
  }

  /**
   * Display empty or loading state in the lyrics wrapper.
   */
  function renderMessage(title, description, icon = '🎵') {
    if (!wrapperEl) return;
    wrapperEl.classList.remove('plain-mode');
    wrapperEl.style.transform = 'none';
    wrapperEl.innerHTML = `
      <div class="lyrics-empty-state">
        <div class="lyrics-empty-icon">${icon}</div>
        <div class="lyrics-empty-title">${title}</div>
        <div class="lyrics-empty-desc">${description}</div>
      </div>
    `;
  }

  /**
   * Render synced or plain lyrics into the wrapper.
   */
  function renderLyrics(data, title, artist) {
    if (!wrapperEl) return;

    trackTitleEl.textContent = title;
    trackArtistEl.textContent = artist;

    if (!data) {
      statusBadgeEl.textContent = 'NO LYRICS';
      statusBadgeEl.className = 'lyrics-status-badge';
      renderMessage('No Lyrics Found', 'No synchronized lyrics found for this track on LRCLIB.', '🔍');
      return;
    }

    if (data.type === 'plain') {
      isSynced = false;
      statusBadgeEl.textContent = data.source === 'ytm' ? 'YTM PLAIN' : 'PLAIN';
      statusBadgeEl.className = 'lyrics-status-badge';
      wrapperEl.classList.add('plain-mode');
      wrapperEl.style.transform = 'none';

      const lines = data.lyrics.split('\n');
      wrapperEl.innerHTML = lines
        .map(line => `<p class="lyric-line">${line || '&nbsp;'}</p>`)
        .join('');
      return;
    }

    // Synced Lyrics
    isSynced = true;
    statusBadgeEl.textContent = 'SYNCED';
    statusBadgeEl.className = 'lyrics-status-badge synced';
    wrapperEl.classList.remove('plain-mode');

    parsedLyrics = parseLRC(data.lyrics);

    if (parsedLyrics.length === 0) {
      renderMessage('Empty Lyrics', 'The lyrics file had no valid timestamped lines.', '⚠️');
      return;
    }

    const fragment = document.createDocumentFragment();
    parsedLyrics.forEach((line, index) => {
      const p = document.createElement('p');
      p.className = 'lyric-line';
      p.dataset.index = index;
      p.textContent = line.text;

      // Click to seek in video
      p.addEventListener('click', () => {
        const video = document.querySelector('video');
        if (video) {
          video.currentTime = line.time;
        }
      });

      fragment.appendChild(p);
    });

    wrapperEl.innerHTML = '';
    wrapperEl.appendChild(fragment);
    wrapperEl.style.transform = 'translateY(0px)';
    activeIndex = -1;

    startSyncLoop();
  }

  /**
   * Main sync loop updating active line and vertical translation.
   */
  function startSyncLoop() {
    if (syncAnimationFrameId) {
      cancelAnimationFrame(syncAnimationFrameId);
      syncAnimationFrameId = null;
    }

    const video = document.querySelector('video');
    if (!video) return;

    function update() {
      if (!isSynced || parsedLyrics.length === 0 || !wrapperEl) {
        return;
      }

      const currentTime = video.currentTime + syncOffset;
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
        const domLines = wrapperEl.getElementsByClassName('lyric-line');

        // Update active class
        for (let i = 0; i < domLines.length; i++) {
          if (i === activeIndex) {
            domLines[i].classList.add('active');
          } else {
            domLines[i].classList.remove('active');
          }
        }

        // Auto scroll translation calculation:
        // Clamping with Math.min(0, ...) keeps the lyrics starting naturally at the top
        // and only scrolling upward as the song progresses!
        if (!isUserScrolling && scrollContainerEl) {
          if (activeIndex !== -1 && domLines[activeIndex]) {
            const activeLine = domLines[activeIndex];
            const targetAnchor = scrollContainerEl.clientHeight * 0.22;
            const lineTop = activeLine.offsetTop;
            const translateY = Math.min(0, targetAnchor - lineTop);

            wrapperEl.style.transform = `translateY(${translateY}px)`;
          } else {
            wrapperEl.style.transform = 'translateY(0px)';
          }
        }
      }

      syncAnimationFrameId = requestAnimationFrame(update);
    }

    syncAnimationFrameId = requestAnimationFrame(update);
  }

  /**
   * Inspect player bar and detect song changes.
   */
  async function checkTrackChange() {
    const titleEl = document.querySelector('ytmusic-player-bar yt-formatted-string.title, ytmusic-player-bar .title');
    const artistEl = document.querySelector('ytmusic-player-bar span.subtitle yt-formatted-string, ytmusic-player-bar .byline, ytmusic-player-bar .subtitle');

    if (!titleEl || !artistEl) return;

    const title = titleEl.textContent?.trim() || '';
    let artist = artistEl.textContent?.trim() || '';

    // Clean artist: take the first segment before bullet separator
    if (artist.includes('•')) {
      artist = artist.split('•')[0].trim();
    } else if (artist.includes('·')) {
      artist = artist.split('·')[0].trim();
    }

    if (!title || !artist) return;

    const songKey = `${title}:::${artist}`;
    if (songKey === currentSongKey) return;

    currentSongKey = songKey;
    syncOffset = 0;
    initLyricsUI();
    injectToggleButton();

    // Show loading state
    if (trackTitleEl) trackTitleEl.textContent = title;
    if (trackArtistEl) trackArtistEl.textContent = artist;
    if (statusBadgeEl) {
      statusBadgeEl.textContent = 'SEARCHING...';
      statusBadgeEl.className = 'lyrics-status-badge';
    }
    renderMessage('Searching Lyrics', `Fetching lyrics for ${title} by ${artist}...`, '⏳');

    // Artwork & dominant color
    const artEl = document.querySelector('ytmusic-player-bar img.image, ytmusic-player-bar #thumbnail img, ytmusic-player-bar img');
    if (artEl && artEl.src) {
      const highResUrl = artEl.src.replace(/w\d+-h\d+/, 'w500-h500');
      extractDominantColor(highResUrl).then(applyColorTheme);
    }

    // Fetch lyrics
    const video = document.querySelector('video');
    const targetDuration = video && !isNaN(video.duration) ? video.duration : 0;
    const data = await fetchLyrics(title, artist, targetDuration);
    if (songKey === currentSongKey) {
      renderLyrics(data, title, artist);
    }
  }

  // --- Observer & Startup ---
  function initObserver() {
    initLyricsUI();
    injectToggleButton();

    // Observe player bar for track mutations
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
      // Fallback: wait for player bar in document
      const docObserver = new MutationObserver((_, obs) => {
        const bar = document.querySelector('ytmusic-player-bar');
        if (bar) {
          obs.disconnect();
          initObserver();
        }
      });

      docObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Dynamic fallback observer: if no lyrics found yet, watch for YTM native lyrics tab loading
    const lyricsObserver = new MutationObserver(() => {
      if (statusBadgeEl && statusBadgeEl.textContent === 'NO LYRICS') {
        const native = getNativeYTMLyrics();
        if (native && currentSongKey) {
          const parts = currentSongKey.split(':::');
          renderLyrics({ type: 'plain', lyrics: native, source: 'ytm' }, parts[0], parts[1] || '');
        }
      }
    });

    lyricsObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver);
  } else {
    initObserver();
  }
})();
