# Chrome Web Store & Edge Add-ons Listing — YTM Sync Lyrics

> Last Updated: 2026-11-09

## Store Listing

**Extension Name** [REQUIRED]
YTM Sync Lyrics

**Short Description** [REQUIRED] (118 / 132 characters)
Synchronized, glassmorphic lyrics for YouTube Music desktop and PWA with real-time scrolling and interactive seek.

**Detailed Description** [REQUIRED]
Enjoy synchronized lyrics directly inside YouTube Music desktop and PWA with a clean, modern aesthetic.

YTM Sync Lyrics brings beautiful, real-time scrolling lyrics that stay in sync with your music:

• Real-Time Lyrics Sync: Follow along with synchronized, timestamped lyrics as each line plays.
• Natural Mobile Design: Clean, high-legibility typography inspired by the YouTube Music mobile experience.
• Dynamic Ambient Glow: The translucent glass panel automatically adapts its background tint to match the current album artwork.
• Interactive Seek: Click on any lyric line to jump the track directly to that exact moment in the song.
• Time Offset Calibration: Fine-tune lyric timing with quick +/- 0.5s buttons if an audio track has leading intro silence.
• Customizable Sizing: Adjust lyric font sizes easily to fit your desktop screen or reading distance.
• Draggable & Persistent: Move the lyrics card anywhere on your screen. Your preferred position and settings are saved automatically.
• Keyboard Shortcut: Toggle the lyrics on or off instantly with Alt + L, or click the music note icon in the bottom player bar.

How to use:
1. Play any song on YouTube Music or open your installed desktop PWA.
2. The lyrics panel will automatically appear with the current track's synchronized lyrics.
3. Drag the header to position the window wherever you prefer on your display.

Privacy & Security:
YTM Sync Lyrics is built with user privacy first. It does not track your browsing history, collect personal information, or run background analytics. All settings are stored locally on your device.

Support & Feedback:
If you encounter tracks with missing lyrics or have suggestions for improvements, please reach out via our GitHub repository.

**Category** [REQUIRED]
Fun (or Photos & Media / Productivity)

**Single Purpose** [REQUIRED]
Displays synchronized, interactive lyrics inside the YouTube Music web player.

**Primary Language** [REQUIRED]
English (or Spanish)

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | 🟡 Pending | `screenshot-1.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

---

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Required to locally store user interface preferences (panel open/closed state, custom drag-and-drop screen position, and chosen font size). |
| `*://music.youtube.com/*` | host_permissions | Required to display the lyrics panel overlay and read the currently playing song title and artist from the YouTube Music interface. |
| `*://*.ggpht.com/*` | host_permissions | Required to fetch album artwork thumbnails to sample dominant colors for the dynamic background theme. |
| `*://*.googleusercontent.com/*` | host_permissions | Required to fetch album artwork thumbnails from Google user content CDNs to extract ambient theme colors. |
| `*://*.youtube.com/*` | host_permissions | Required to access YouTube Music player elements and embedded artwork. |
| `https://lrclib.net/*` | host_permissions | Required to query the open-source LRCLIB lyrics database API to retrieve synchronized lyrics for the active track. |

---

## Privacy & Data Use

### Data Collection
**Does the extension collect user data?** No.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Packaging for Store Upload

Run this command in the project directory to build the submission zip file:

```bash
zip -r ytm-sync-lyrics.zip manifest.json content.js styles.css icons/
```
