# Privacy Policy for YTM Sync Lyrics

> Last updated: 2026-11-09

YTM Sync Lyrics ("the extension") is committed to respecting your privacy. This policy explains how the extension handles user data.

## 1. What Data We Collect
**YTM Sync Lyrics does not collect, track, or share any personally identifiable information (PII).**

The extension only stores non-sensitive user UI preferences locally on your device via `chrome.storage.local`:
- Panel visibility state (open / closed).
- Panel screen coordinates (saved position from drag-and-drop).
- Selected lyric font size.

## 2. Network Requests & Third-Party Services
To provide synchronized lyrics, the extension performs read-only requests to:
- **LRCLIB API** (`https://lrclib.net/`): Queries song title and artist name to retrieve timestamped lyric lines. No user identifiers, cookies, or account details are ever transmitted.
- **Album Artwork CDN** (`yt3.ggpht.com`, `googleusercontent.com`): Fetches the current track thumbnail locally in your browser strictly to sample ambient background colors for the glassmorphic theme.

## 3. Data Storage & Retention
All preferences remain exclusively within your browser's local extension storage. No data is synchronized to external servers or sold to third parties.

## 4. Contact
If you have questions regarding this privacy policy or the extension, please open an issue on the project's repository.
