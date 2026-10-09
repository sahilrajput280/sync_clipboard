const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
// Raw binary body parser for clipboard images and chunks (must be before express.json)
app.use('/api/clipboard-image', express.raw({ type: '*/*', limit: '50mb' }));
app.use('/api/clipboard-image-chunk', express.raw({ type: '*/*', limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory Store ────────────────────────────────────────────────────────────
// pairingCodes: { code: { sessionId, createdAt } }
const pairingCodes = new Map();
// sessions: { sessionId: { windowsWs, macWs, clipboardHistory, lastActivity, windowsConnected } }
const sessions = new Map();
// wsToSession: WeakMap to look up session from ws
const wsToSession = new WeakMap();
// imageStore: { imageId: { buffer, mimeType, timestamp } }
const imageStore = new Map();
// pendingImageChunks: { imageId: { chunks, totalChunks, received, mimeType, sessionId, createdAt } }
const pendingImageChunks = new Map();
const MAX_STORED_IMAGES = 40;

const PAIRING_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HISTORY = 20;
const HEARTBEAT_INTERVAL = 15000;
const CONNECTION_TIMEOUT = 45000;

// ─── Utility ────────────────────────────────────────────────────────────────────

function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,1,O,0
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function cleanExpiredCodes() {
  const now = Date.now();
  for (const [code, data] of pairingCodes) {
    if (now - data.createdAt > PAIRING_CODE_EXPIRY_MS) {
      pairingCodes.delete(code);
    }
  }
}

function cleanOldImages() {
  if (imageStore.size > MAX_STORED_IMAGES) {
    const keys = Array.from(imageStore.keys());
    const toRemove = keys.slice(0, imageStore.size - MAX_STORED_IMAGES);
    toRemove.forEach(k => imageStore.delete(k));
  }
}

function sendJson(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('[WS] Send error:', err.message);
    }
  }
}

function getOrCreateSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      windowsWs: null,
      macWs: null,
      clipboardHistory: [],
      lastActivity: Date.now(),
      windowsConnected: false
    };
    sessions.set(sessionId, session);
  }
  return session;
}

// ─── REST API ───────────────────────────────────────────────────────────────────

// Windows app requests a pairing code
app.post('/api/request-pairing', (req, res) => {
  cleanExpiredCodes();

  const { sessionId, forceNew } = req.body;

  // If reconnecting with existing session and NOT requesting a new code
  if (!forceNew && sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    // Only reconnect if this session already had a Mac connected
    if (session.macWs) {
      return res.json({
        success: true,
        sessionId,
        reconnected: true,
        message: 'Reconnected to existing session'
      });
    }
  }

  const code = generatePairingCode();
  const newSessionId = uuidv4();

  pairingCodes.set(code, {
    sessionId: newSessionId,
    createdAt: Date.now()
  });

  // Pre-create session
  sessions.set(newSessionId, {
    windowsWs: null,
    macWs: null,
    clipboardHistory: [],
    lastActivity: Date.now(),
    windowsConnected: false
  });

  console.log(`[Pairing] Code generated: ${code} → Session: ${newSessionId.slice(0, 8)}...`);

  res.json({
    success: true,
    code,
    sessionId: newSessionId
  });
});

// Mac enters pairing code
app.post('/api/pair', (req, res) => {
  cleanExpiredCodes();

  const { code } = req.body;
  const normalizedCode = (code || '').toUpperCase().replace(/\s/g, '');

  const pairingData = pairingCodes.get(normalizedCode);

  if (!pairingData) {
    return res.json({
      success: false,
      error: 'Invalid or expired pairing code. Please check the code and try again.'
    });
  }

  const { sessionId } = pairingData;
  pairingCodes.delete(normalizedCode); // one-time use

  getOrCreateSession(sessionId);

  console.log(`[Pairing] Code ${normalizedCode} redeemed → Session: ${sessionId.slice(0, 8)}...`);

  res.json({
    success: true,
    sessionId,
    message: 'Successfully paired! You will now receive clipboard updates from Windows.'
  });
});

// Windows uploads an image via HTTP POST (bypasses WebSocket frame size limits)
app.post('/api/clipboard-image', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const rawMime = req.headers['content-type'] || 'image/png';
  const mimeType = rawMime.split(';')[0].trim();

  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Missing x-session-id header' });
  }

  const buffer = req.body;
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ success: false, error: 'Empty or invalid image data' });
  }

  const session = getOrCreateSession(sessionId);
  const imageId = uuidv4();

  cleanOldImages();
  imageStore.set(imageId, {
    buffer,
    mimeType,
    timestamp: Date.now()
  });

  const item = {
    id: imageId,
    contentType: 'image',
    content: null, // Streamed via GET /api/clipboard-image/:id
    mimeType,
    timestamp: Date.now(),
    size: buffer.length
  };

  session.clipboardHistory.unshift(item);
  if (session.clipboardHistory.length > MAX_HISTORY) {
    session.clipboardHistory = session.clipboardHistory.slice(0, MAX_HISTORY);
  }
  session.lastActivity = Date.now();

  // Notify Mac over WebSocket (lightweight ~200B message)
  if (session.macWs && session.macWs.readyState === WebSocket.OPEN) {
    sendJson(session.macWs, {
      type: 'clipboard',
      item
    });
  }

  console.log(`[HTTP Image] ${(buffer.length / 1024).toFixed(1)}KB (${mimeType}) → Session: ${sessionId.slice(0, 8)}... (Mac WS open: ${!!(session.macWs && session.macWs.readyState === WebSocket.OPEN)})`);

  res.json({ success: true, id: imageId });
});

// Windows uploads an image in small resilient chunks (bypasses any proxy/WAF/ISP packet limits)
app.post('/api/clipboard-image-chunk', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const imageId = req.headers['x-image-id'];
  const chunkIndex = parseInt(req.headers['x-chunk-index'], 10);
  const totalChunks = parseInt(req.headers['x-total-chunks'], 10);
  const rawMime = req.headers['x-mime-type'] || 'image/jpeg';
  const mimeType = rawMime.split(';')[0].trim();

  if (!sessionId || !imageId || isNaN(chunkIndex) || isNaN(totalChunks)) {
    return res.status(400).json({ success: false, error: 'Missing chunk headers' });
  }

  const chunkBuffer = req.body;
  if (!chunkBuffer || !Buffer.isBuffer(chunkBuffer)) {
    return res.status(400).json({ success: false, error: 'Invalid chunk buffer' });
  }

  let pending = pendingImageChunks.get(imageId);
  if (!pending) {
    pending = {
      chunks: new Array(totalChunks),
      totalChunks,
      received: 0,
      mimeType,
      sessionId,
      createdAt: Date.now()
    };
    pendingImageChunks.set(imageId, pending);
  }

  if (!pending.chunks[chunkIndex]) {
    pending.chunks[chunkIndex] = chunkBuffer;
    pending.received++;
  }

  // All chunks received -> assemble and deliver!
  if (pending.received >= pending.totalChunks) {
    pendingImageChunks.delete(imageId);
    const fullBuffer = Buffer.concat(pending.chunks);

    const session = getOrCreateSession(sessionId);
    cleanOldImages();
    imageStore.set(imageId, {
      buffer: fullBuffer,
      mimeType: pending.mimeType,
      timestamp: Date.now()
    });

    const item = {
      id: imageId,
      contentType: 'image',
      content: null,
      mimeType: pending.mimeType,
      timestamp: Date.now(),
      size: fullBuffer.length
    };

    session.clipboardHistory.unshift(item);
    if (session.clipboardHistory.length > MAX_HISTORY) {
      session.clipboardHistory = session.clipboardHistory.slice(0, MAX_HISTORY);
    }
    session.lastActivity = Date.now();

    if (session.macWs && session.macWs.readyState === WebSocket.OPEN) {
      sendJson(session.macWs, {
        type: 'clipboard',
        item
      });
    }

    console.log(`[Chunked Image Complete] ${(fullBuffer.length / 1024).toFixed(1)}KB (${pending.mimeType}, ${totalChunks} chunks) → Session: ${sessionId.slice(0, 8)}... (Mac WS open: ${!!(session.macWs && session.macWs.readyState === WebSocket.OPEN)})`);
    return res.json({ success: true, complete: true, id: imageId });
  }

  res.json({ success: true, complete: false, received: pending.received, total: totalChunks });
});

// Mac fetches image binary
app.get('/api/clipboard-image/:id', (req, res) => {
  const img = imageStore.get(req.params.id);
  if (!img) {
    return res.status(404).send('Image not found or expired');
  }
  res.set('Content-Type', img.mimeType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(img.buffer);
});

// Large text payload endpoint
app.post('/api/clipboard-text', (req, res) => {
  const { sessionId, content } = req.body;
  if (!sessionId || !content) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }

  const session = getOrCreateSession(sessionId);
  const item = {
    id: uuidv4(),
    contentType: 'text',
    content,
    mimeType: 'text/plain',
    timestamp: Date.now(),
    size: content.length
  };

  session.clipboardHistory.unshift(item);
  if (session.clipboardHistory.length > MAX_HISTORY) {
    session.clipboardHistory = session.clipboardHistory.slice(0, MAX_HISTORY);
  }
  session.lastActivity = Date.now();

  if (session.macWs && session.macWs.readyState === WebSocket.OPEN) {
    sendJson(session.macWs, {
      type: 'clipboard',
      item
    });
  }

  console.log(`[HTTP Text] ${content.length} chars → Session: ${sessionId.slice(0, 8)}...`);
  res.json({ success: true, id: item.id });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    pendingCodes: pairingCodes.size,
    cachedImages: imageStore.size
  });
});

// Fallback to serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ──────────────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  let sessionId = null;
  let role = null; // 'windows' or 'mac'

  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // ── Registration ──────────────────────────────────────────────────────
      case 'register': {
        sessionId = msg.sessionId;
        role = msg.role; // 'windows' or 'mac'

        if (!sessionId) {
          sendJson(ws, { type: 'error', message: 'Missing sessionId.' });
          return;
        }

        // Auto-restore session if server restarted
        const session = getOrCreateSession(sessionId);

        if (role === 'windows') {
          // Close old windows connection if exists
          if (session.windowsWs && session.windowsWs !== ws) {
            sendJson(session.windowsWs, { type: 'replaced', message: 'Another Windows instance connected.' });
            session.windowsWs.close();
          }
          session.windowsWs = ws;
          session.windowsConnected = true;
          session.lastActivity = Date.now();
          wsToSession.set(ws, { sessionId, role });

          sendJson(ws, { type: 'registered', role: 'windows', message: 'Windows registered successfully.' });

          // Notify Mac
          if (session.macWs) {
            sendJson(session.macWs, { type: 'windows-status', connected: true });
          }

          console.log(`[WS] Windows connected → Session: ${sessionId.slice(0, 8)}...`);
        } else if (role === 'mac') {
          // Close old mac connection if exists
          if (session.macWs && session.macWs !== ws) {
            session.macWs.close();
          }
          session.macWs = ws;
          wsToSession.set(ws, { sessionId, role });

          sendJson(ws, {
            type: 'registered',
            role: 'mac',
            windowsConnected: session.windowsConnected,
            history: session.clipboardHistory,
            message: 'Mac registered successfully.'
          });

          // Notify Windows that Mac connected
          if (session.windowsWs) {
            sendJson(session.windowsWs, {
              type: 'mac-connected',
              message: 'Mac paired and connected successfully!'
            });
          }

          console.log(`[WS] Mac connected → Session: ${sessionId.slice(0, 8)}...`);
        }
        break;
      }

      // ── Clipboard Data (Windows → Server → Mac) ──────────────────────────
      case 'clipboard': {
        if (role !== 'windows' || !sessionId) return;
        const session = getOrCreateSession(sessionId);

        let item;
        if (msg.contentType === 'image' && msg.content) {
          // If sent via WS base64 fallback, store in imageStore
          const imageId = uuidv4();
          const buf = Buffer.from(msg.content, 'base64');
          cleanOldImages();
          imageStore.set(imageId, {
            buffer: buf,
            mimeType: msg.mimeType || 'image/png',
            timestamp: Date.now()
          });

          item = {
            id: imageId,
            contentType: 'image',
            content: null,
            mimeType: msg.mimeType || 'image/png',
            timestamp: Date.now(),
            size: buf.length
          };
        } else {
          item = {
            id: uuidv4(),
            contentType: msg.contentType,
            content: msg.content,
            mimeType: msg.mimeType || null,
            timestamp: Date.now(),
            size: msg.content ? msg.content.length : 0
          };
        }

        // Add to history (newest first)
        session.clipboardHistory.unshift(item);
        if (session.clipboardHistory.length > MAX_HISTORY) {
          session.clipboardHistory = session.clipboardHistory.slice(0, MAX_HISTORY);
        }
        session.lastActivity = Date.now();

        // Forward to Mac
        if (session.macWs && session.macWs.readyState === WebSocket.OPEN) {
          sendJson(session.macWs, {
            type: 'clipboard',
            item
          });
        }

        console.log(`[Clipboard] ${msg.contentType} (${(item.size / 1024).toFixed(1)}KB) → Session: ${sessionId.slice(0, 8)}...`);
        break;
      }

      // ── Heartbeat from Windows ────────────────────────────────────────────
      case 'heartbeat': {
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (session) {
            session.lastActivity = Date.now();
            sendJson(ws, { type: 'heartbeat-ack' });
          }
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;

    if (role === 'windows' && session.windowsWs === ws) {
      session.windowsWs = null;
      session.windowsConnected = false;
      console.log(`[WS] Windows disconnected → Session: ${sessionId.slice(0, 8)}...`);

      // Notify Mac
      if (session.macWs) {
        sendJson(session.macWs, { type: 'windows-status', connected: false });
      }
    } else if (role === 'mac' && session.macWs === ws) {
      session.macWs = null;
      console.log(`[WS] Mac disconnected → Session: ${sessionId.slice(0, 8)}...`);

      // Notify Windows
      if (session.windowsWs) {
        sendJson(session.windowsWs, { type: 'mac-disconnected', message: 'Mac disconnected' });
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error: ${err.message}`);
  });
});

// ─── Heartbeat Interval ─────────────────────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ─── Cleanup stale sessions ─────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    // Remove sessions inactive for > 24 hours with no connections
    if (!session.windowsWs && !session.macWs && now - session.lastActivity > 24 * 60 * 60 * 1000) {
      sessions.delete(id);
      console.log(`[Cleanup] Removed stale session: ${id.slice(0, 8)}...`);
    }
  }
}, 60 * 60 * 1000); // every hour

// ─── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║           ClipboardSync Server v1.0.0                ║`);
  console.log(`║──────────────────────────────────────────────────────║`);
  console.log(`║  HTTP  → http://localhost:${PORT}                      ║`);
  console.log(`║  WS    → ws://localhost:${PORT}                        ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);
});
