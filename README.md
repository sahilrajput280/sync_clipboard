# ClipboardSync

**One-way, real-time clipboard synchronization from Windows → Mac**

A personal clipboard bridge that automatically detects anything you copy on your Windows computer and instantly makes it available on your Mac through a clean web interface.

---

## Architecture

```
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│  Windows App     │  WS    │   Relay Server   │  WS    │   Mac Browser    │
│  (Electron)      │───────▶│   (Node.js)      │───────▶│   (Web App)      │
│                  │        │                  │        │                  │
│  • Monitors      │        │  • Handles       │        │  • Displays      │
│    clipboard     │        │    pairing       │        │    clipboard     │
│  • Sends text    │        │  • Relays data   │        │  • Copy/download │
│    & images      │        │  • In-memory     │        │  • History       │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

**Direction: Windows → Mac only. Never the reverse.**

---

## Quick Start

### 1. Start the Relay Server

The server acts as the bridge between your Windows computer and Mac. Run it on any machine that both can reach (the Mac itself, or a VPS, etc.).

```bash
cd server
npm install
npm start
```

The server starts at `http://localhost:3000`. Note the IP address of this machine — you'll need it.

### 2. Launch the Windows App

```bash
cd windows-app
npm install
npm start
```

1. Enter the server address (e.g., `192.168.1.100:3000`)
2. Click **Generate Pairing Code**
3. A code like `8K4P-72XM` appears
4. Leave this open or minimize to tray

### 3. Open the Mac Web App

1. On your Mac, open a browser and go to `http://<server-ip>:3000`
2. Enter the pairing code from the Windows app
3. Click **Connect**
4. ✅ You're paired!

### 4. Use It

- Copy anything on Windows (text or images)
- It appears on the Mac web app instantly
- Click **Copy** to place it in your Mac clipboard
- Minimize the Windows app — it keeps working in the background

---

## Features

| Feature | Details |
|---|---|
| **Text sync** | Any copied text is transferred instantly |
| **Image sync** | Screenshots and copied images (up to 10MB) |
| **Background operation** | Windows app runs in system tray |
| **Auto-reconnect** | Reconnects automatically if connection drops |
| **Pairing codes** | Secure, time-limited pairing (10 min expiry) |
| **Clipboard history** | Last 20 items accessible on Mac |
| **Copy to Mac** | One-click copy for text, copy/download for images |
| **Connection status** | Real-time indicator on both sides |
| **Auto-start** | Optional Windows startup launch |
| **No permanent storage** | Clipboard data is in-memory only |

---

## Building the Windows Installer

To create a distributable `.exe` installer:

```bash
cd windows-app
npm run build
```

The installer will be in `windows-app/dist/`.

**Note:** You'll need a proper `.ico` file for the build. Convert the SVG icon in `assets/` to `.ico` format (256x256) and save as `assets/icon.ico`.

---

## Project Structure

```
ACCESSIBIT/
├── server/                    # Relay server + Mac web app
│   ├── package.json
│   ├── index.js               # Express + WebSocket server
│   └── public/                # Mac web interface
│       ├── index.html
│       ├── style.css
│       └── app.js
├── windows-app/               # Electron desktop app
│   ├── package.json
│   ├── main.js                # Main process (clipboard + WS)
│   ├── preload.js             # Context bridge
│   ├── renderer/              # UI
│   │   ├── index.html
│   │   ├── style.css
│   │   └── app.js
│   └── assets/
│       └── icon.svg
└── README.md
```

---

## Deployment Options

### Local Network (Simplest)
Run the server on your Mac:
```bash
cd server && npm start
```
Both machines must be on the same network. Use your Mac's IP address.

### Cloud / VPS
Deploy the server to any Node.js host (Render, Railway, DigitalOcean, etc.):
```bash
# On your VPS
git clone <repo>
cd server
npm install
PORT=3000 npm start
```

For HTTPS/WSS (recommended for production), put it behind nginx or use a platform that provides SSL.

---

## Security Notes

- Pairing codes are **one-time use** and expire after **10 minutes**
- Sessions are stored **in-memory only** — restart the server and all sessions are cleared
- Clipboard data is **never written to disk**
- Only paired devices can communicate
- Stale sessions are automatically cleaned up after 24 hours of inactivity

---

## Requirements

- **Server**: Node.js 18+
- **Windows App**: Node.js 18+ (for development), or use the built installer
- **Mac**: Any modern browser (Chrome, Safari, Firefox, Edge)
