# RKB Desktop Companion

Electron shell for **RKB — Real-Time Knowledge Buddy AI**.
Loads the existing web UI (`../index.html` served by `../server.js`) and adds
desktop-only powers the browser cannot provide.

## Features

- Transparent, frameless window
- Always-On-Top
- Click-Through (mouse passes to apps below)
- Opacity slider (20% – 100%)
- Character Scale
- Snap to 4 corners
- Position memory
- System tray with quick menu
- Global hotkey (`Ctrl+Space`, `Ctrl+Shift+R`, `Alt+Space`)
- Allowlisted OS actions via `/api/action` on the local server
- Auto-launches the RKB server if it is not already running

## Install

```bash
cd desktop
npm install