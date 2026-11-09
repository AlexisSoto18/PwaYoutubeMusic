# YTM Sync Lyrics

A modern Manifest V3 Chrome/Edge extension that brings Apple Music-style glassmorphic, synchronized lyrics to YouTube Music Desktop and PWA.

## Features

- **Real-Time Synchronized Lyrics**: Powered by [LRCLIB](https://lrclib.net/) open-source lyrics API.
- **Glassmorphism Aesthetic**: Translucent backdrop blur with dynamic saturated tinting matching the current album art.
- **Dynamic Color Extraction**: Samples album artwork via an offscreen canvas to dynamically adapt the panel background and ambient glow.
- **Smooth Auto-Centering Scroll**: Calculates the vertical midpoint dynamically so the current lyric line is always highlighted and centered.
- **Interactive Seek**: Click on any lyric line to jump the track directly to that timestamp.
- **Manual Scroll Awareness**: Detects manual user scrolling and temporarily pauses auto-centering for 3.5 seconds before snapping back.
- **Desktop & PWA Compatible**: Works seamlessly both on `music.youtube.com` in standard tabs and inside the installed YouTube Music desktop PWA.
- **Dedicated Controls**: Injected player bar toggle button and keyboard shortcut (`Alt + L`).

---

## Installation & Setup

1. Open your browser's extension management page:
   - **Chrome / Brave**: navigate to `chrome://extensions/`
   - **Microsoft Edge**: navigate to `edge://extensions/`
2. Enable **Developer mode** (toggle located in the top-right corner).
3. Click the **Load unpacked** button.
4. Select this project folder (`/home/alexis/Documentos/Proyectos/PwaYoutubeMusic`).
5. Open [YouTube Music](https://music.youtube.com/) or launch your YouTube Music desktop PWA.
6. Play any song — the lyrics panel will appear automatically. You can toggle it at any time with the icon in the bottom player bar or with `Alt + L`.

---

## Project Structure

```
├── manifest.json       # Manifest V3 extension configuration
├── content.js          # DOM observer, LRCLIB fetcher, canvas color extractor & sync loop
├── styles.css          # Glassmorphism, animations, gradient masking & typography
├── icons/              # 16x16, 48x48, 128x128 extension icons
└── README.md
```

## Technical Architecture

- **Manifest V3**: Uses declarative host permissions and idle content script injection.
- **CORS-safe Color Sampling**: Fetches the album art as a Blob to prevent CORS canvas taint while sampling dominant RGB values.
- **Math formula for vertical centering**:
  $$\text{translateY} = \left(\frac{\text{viewportHeight}}{2}\right) - \left(\text{offsetTop} + \frac{\text{lineHeight}}{2}\right)$$
