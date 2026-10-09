/* ═══════════════════════════════════════════════════════════════════════════════
   ClipboardSync — Windows Electron Main Process
   Monitors clipboard, manages pairing, sends data to relay server via WebSocket
   Runs in system tray for background operation
   ═══════════════════════════════════════════════════════════════════════════════ */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  clipboard,
  nativeImage,
  ipcMain,
  dialog,
  shell
} = require('electron');
const path = require('path');
const WebSocket = require('ws');
const Store = require('electron-store');

// ─── Configuration ──────────────────────────────────────────────────────────
const CLIPBOARD_POLL_INTERVAL_MS = 500;
const WS_RECONNECT_DELAY_MS = 2000;
const WS_MAX_RECONNECT_DELAY = 30000;
const HEARTBEAT_INTERVAL_MS = 10000;
const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit for images

// ─── State ──────────────────────────────────────────────────────────────────
const store = new Store({
  name: 'clipboardsync-config',
  defaults: {
    serverUrl: '',
    sessionId: null,
    autoLaunch: false,
    minimizeToTray: true
  }
});

let mainWindow = null;
let tray = null;
let ws = null;
let clipboardTimer = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastClipboardText = '';
let lastClipboardImageHash = '';
let isConnected = false;
let isPaired = false;
let sessionId = null;
let serverUrl = '';

// ─── Single Instance Lock ───────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();

  // Load saved session
  sessionId = store.get('sessionId');
  serverUrl = store.get('serverUrl');

  if (sessionId && serverUrl) {
    isPaired = true;
    sendToRenderer('session-loaded', { sessionId, serverUrl, isPaired: true });
    connectWebSocket();
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit on window close; keep running in tray
  // Only quit explicitly from tray menu
});

app.on('before-quit', () => {
  stopClipboardMonitor();
  if (ws) ws.close();
  if (tray) tray.destroy();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

// ─── Window ─────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 620,
    minWidth: 380,
    minHeight: 500,
    resizable: true,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (store.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── System Tray ────────────────────────────────────────────────────────────
function createTray() {
  // Create a simple tray icon using nativeImage
  const trayIcon = createTrayIcon(false);
  tray = new Tray(trayIcon);

  updateTrayMenu();
  tray.setToolTip('ClipboardSync');

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

function createTrayIcon(connected) {
  // Create a 16x16 icon programmatically
  const size = 16;
  const canvas = nativeImage.createEmpty();

  // Use a simple colored square as tray icon
  // Green when connected, gray when disconnected
  const color = connected ? '#22c55e' : '#6366f1';
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" rx="3" fill="${color}"/>
      <text x="50%" y="52%" dominant-baseline="middle" text-anchor="middle" fill="white" font-size="10" font-weight="bold" font-family="Arial">C</text>
    </svg>`;

  return nativeImage.createFromBuffer(
    Buffer.from(svg),
    { width: size, height: size }
  );
}

function updateTrayMenu() {
  const statusLabel = isConnected ? '● Connected (Windows → Mac)' : '○ Disconnected';

  const contextMenu = Menu.buildFromTemplate([
    { label: 'ClipboardSync', enabled: false },
    { type: 'separator' },
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit ClipboardSync',
      click: () => {
        app.exit(0);
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setImage(createTrayIcon(isConnected));
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────
ipcMain.handle('get-state', () => {
  return {
    sessionId,
    serverUrl,
    isPaired,
    isConnected,
    minimizeToTray: store.get('minimizeToTray'),
    autoLaunch: store.get('autoLaunch')
  };
});

ipcMain.handle('set-server-url', async (event, url) => {
  // Normalize URL
  let normalized = url.trim().replace(/\/+$/, '');
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    if (normalized.startsWith('localhost') || normalized.startsWith('127.0.0.1') || /^192\.168\./.test(normalized) || /^10\./.test(normalized)) {
      normalized = 'http://' + normalized;
    } else {
      normalized = 'https://' + normalized;
    }
  }
  serverUrl = normalized;
  store.set('serverUrl', normalized);
  return { success: true, serverUrl: normalized };
});

ipcMain.handle('request-pairing', async () => {
  if (!serverUrl) {
    return { success: false, error: 'Server URL not set' };
  }

  try {
    const http = serverUrl.startsWith('https') ? require('https') : require('http');

    return new Promise((resolve) => {
      const url = new URL('/api/request-pairing', serverUrl);
      const body = JSON.stringify({ forceNew: true });

      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.success && json.code) {
              sessionId = json.sessionId;
              isPaired = false;
              stopClipboardMonitor();
              if (ws) {
                try { ws.close(); } catch(e) {}
                ws = null;
              }
              resolve({ success: true, code: json.code, sessionId });
            } else {
              resolve({ success: false, error: json.error || 'Failed to get pairing code' });
            }
          } catch (e) {
            resolve({ success: false, error: 'Invalid server response' });
          }
        });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: `Cannot reach server: ${err.message}` });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve({ success: false, error: 'Server connection timed out' });
      });

      req.write(body);
      req.end();
    });
  } catch (err) {
    return { success: false, error: `Connection error: ${err.message}` };
  }
});

ipcMain.handle('connect-ws', () => {
  if (sessionId && serverUrl) {
    isPaired = true;
    connectWebSocket();
    return { success: true };
  }
  return { success: false, error: 'Not paired yet' };
});

ipcMain.handle('disconnect', () => {
  isPaired = false;
  isConnected = false;
  sessionId = null;
  store.delete('sessionId');
  stopClipboardMonitor();
  if (ws) ws.close();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  updateTrayMenu();
  return { success: true };
});

ipcMain.handle('minimize-to-tray', () => {
  if (mainWindow) mainWindow.hide();
  return { success: true };
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('set-auto-launch', (event, enabled) => {
  store.set('autoLaunch', enabled);
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: app.getPath('exe')
  });
  return { success: true };
});

ipcMain.handle('set-minimize-to-tray', (event, enabled) => {
  store.set('minimizeToTray', enabled);
  return { success: true };
});

// ─── WebSocket Connection ───────────────────────────────────────────────────
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsProtocol = serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = serverUrl.replace(/^https?/, wsProtocol);

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('[WS] Failed to create WebSocket:', err.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[WS] Connected to server');
    reconnectAttempts = 0;

    // Register as Windows
    ws.send(JSON.stringify({
      type: 'register',
      sessionId,
      role: 'windows'
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'registered':
        isConnected = true;
        updateTrayMenu();
        startHeartbeat();
        if (isPaired) {
          startClipboardMonitor();
        }
        sendToRenderer('connected', { isPaired, message: msg.message });
        console.log('[WS] Registered as Windows (paired=' + isPaired + ')');
        break;

      case 'heartbeat-ack':
        // Server acknowledged heartbeat
        break;

      case 'mac-connected':
        isPaired = true;
        store.set('sessionId', sessionId);
        startClipboardMonitor();
        updateTrayMenu();
        sendToRenderer('mac-connected', { message: msg.message });
        console.log('[WS] Mac paired and connected!');
        break;

      case 'mac-disconnected':
        sendToRenderer('mac-disconnected', { message: msg.message });
        break;

      case 'error':
        console.error('[WS] Server error:', msg.message);
        sendToRenderer('error', { message: msg.message });
        break;

      case 'replaced':
        console.log('[WS] Replaced by another instance');
        isConnected = false;
        stopClipboardMonitor();
        sendToRenderer('replaced', { message: msg.message });
        break;
    }
  });

  ws.on('close', () => {
    console.log('[WS] Disconnected');
    isConnected = false;
    updateTrayMenu();
    stopHeartbeat();
    sendToRenderer('disconnected');

    if (isPaired) {
      scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(WS_RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts), WS_MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  console.log(`[WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})`);
  sendToRenderer('reconnecting', { attempt: reconnectAttempts, delay });
  reconnectTimer = setTimeout(() => connectWebSocket(), delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Clipboard Monitor ──────────────────────────────────────────────────────
function startClipboardMonitor() {
  stopClipboardMonitor();

  // Initialize with current clipboard content to avoid sending existing content
  try {
    lastClipboardText = clipboard.readText() || '';
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) {
      lastClipboardImageHash = hashImageData(img);
    }
  } catch (e) {
    console.error('[Clipboard] Init error:', e.message);
  }

  clipboardTimer = setInterval(() => {
    checkClipboard();
  }, CLIPBOARD_POLL_INTERVAL_MS);

  console.log('[Clipboard] Monitoring started');
  sendToRenderer('monitoring', { active: true });
}

function stopClipboardMonitor() {
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
    console.log('[Clipboard] Monitoring stopped');
    sendToRenderer('monitoring', { active: false });
  }
}

function checkClipboard() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    // Check for image first (takes priority)
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) {
      const hash = hashImageData(img);
      if (hash && hash !== lastClipboardImageHash) {
        lastClipboardImageHash = hash;
        lastClipboardText = ''; // Reset text tracking

        const size = img.getSize();
        let targetImg = img;
        if (size.width > 1600) {
          const ratio = 1600 / size.width;
          targetImg = img.resize({
            width: 1600,
            height: Math.round(size.height * ratio),
            quality: 'better'
          });
        }

        // JPEG 75 gives crisp screenshot readability with a tiny, super-fast payload
        const buffer = targetImg.toJPEG(75);
        const mimeType = 'image/jpeg';

        if (buffer.length <= MAX_IMAGE_SIZE_BYTES) {
          uploadClipboardImage(buffer, mimeType, size);
        } else {
          console.log(`[Clipboard] Image too large (${(buffer.length / (1024 * 1024)).toFixed(1)}MB), skipped`);
          sendToRenderer('clipboard-error', { message: 'Image too large to send (>10MB)' });
        }
        return;
      }
    }

    // Check for text
    const text = clipboard.readText();
    if (text && text !== lastClipboardText && text.trim().length > 0) {
      lastClipboardText = text;
      lastClipboardImageHash = ''; // Reset image hash so next image is captured reliably

      if (text.length > 15000) {
        uploadClipboardText(text);
      } else {
        ws.send(JSON.stringify({
          type: 'clipboard',
          contentType: 'text',
          content: text
        }));

        sendToRenderer('clipboard-sent', {
          contentType: 'text',
          preview: text.length > 60 ? text.slice(0, 60) + '…' : text
        });

        console.log(`[Clipboard] Text sent (${text.length} chars)`);
      }
    }
  } catch (err) {
    console.error('[Clipboard] Check error:', err.message);
  }
}

async function uploadClipboardImage(buffer, mimeType, size) {
  if (!serverUrl || !sessionId) return;

  const crypto = require('crypto');
  const imageId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2) + Date.now();
  const CHUNK_SIZE = 4096; // 4KB chunks ensure 100% transmission across any ISP, CGNAT, or Cloudflare edge
  const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);

  console.log(`[Clipboard] Uploading ${size.width}x${size.height} (${(buffer.length / 1024).toFixed(1)}KB) in ${totalChunks} chunks...`);

  const isHttps = serverUrl.startsWith('https');
  const httpLib = isHttps ? require('https') : require('http');

  function sendOneChunk(index, chunkBuffer, maxRetries = 6) {
    return new Promise((resolve, reject) => {
      let attempt = 0;

      function trySend() {
        attempt++;
        const url = new URL('/api/clipboard-image-chunk', serverUrl);
        const req = httpLib.request(url, {
          method: 'POST',
          agent: false, // Clean new socket every time to bypass TLS poisoning/fragmentation
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': chunkBuffer.length,
            'x-session-id': sessionId,
            'x-image-id': imageId,
            'x-chunk-index': String(index),
            'x-total-chunks': String(totalChunks),
            'x-mime-type': mimeType
          }
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve();
            } else {
              if (attempt < maxRetries) {
                setTimeout(trySend, 150 * attempt);
              } else {
                reject(new Error(`Server returned HTTP ${res.statusCode}`));
              }
            }
          });
        });

        req.on('error', (err) => {
          if (attempt < maxRetries) {
            setTimeout(trySend, 150 * attempt);
          } else {
            reject(err);
          }
        });

        req.setTimeout(15000, () => {
          req.destroy();
          if (attempt < maxRetries) {
            setTimeout(trySend, 150 * attempt);
          } else {
            reject(new Error('Chunk upload timed out'));
          }
        });

        req.write(chunkBuffer);
        req.end();
      }

      trySend();
    });
  }

  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, buffer.length);
      const chunk = buffer.subarray(start, end);
      await sendOneChunk(i, chunk);
    }

    sendToRenderer('clipboard-sent', {
      contentType: 'image',
      size: buffer.length
    });
    console.log(`[Clipboard] Image uploaded successfully: ${size.width}x${size.height} (${(buffer.length / 1024).toFixed(1)}KB)`);
  } catch (err) {
    console.error('[Clipboard] Image upload failed:', err.message);
    sendToRenderer('clipboard-error', { message: `Image send failed: ${err.message}` });
  }
}

function uploadClipboardText(text) {
  if (!serverUrl || !sessionId) return;

  try {
    const isHttps = serverUrl.startsWith('https');
    const httpLib = isHttps ? require('https') : require('http');
    const url = new URL('/api/clipboard-text', serverUrl);
    const body = JSON.stringify({ sessionId, content: text });

    const req = httpLib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success) {
            sendToRenderer('clipboard-sent', {
              contentType: 'text',
              preview: text.length > 60 ? text.slice(0, 60) + '…' : text
            });
            console.log(`[Clipboard] Large text uploaded (${text.length} chars)`);
          }
        } catch (e) {}
      });
    });

    req.on('error', (err) => console.error('[Clipboard] Text upload error:', err.message));
    req.write(body);
    req.end();
  } catch (err) {
    console.error('[Clipboard] uploadClipboardText error:', err.message);
  }
}

function hashImageData(img) {
  try {
    const size = img.getSize();
    if (size.width === 0 || size.height === 0) return '';
    const bmp = img.toBitmap();
    const sample = bmp.slice(0, Math.min(64, bmp.length));
    return `${size.width}x${size.height}_${bmp.length}_${sample.toString('hex')}`;
  } catch (e) {
    return '';
  }
}

// ─── IPC Helper ─────────────────────────────────────────────────────────────
function sendToRenderer(channel, data = {}) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, data);
  }
}
