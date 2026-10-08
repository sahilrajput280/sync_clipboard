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
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-Memory Store ────────────────────────────────────────────────────────────
// pairingCodes: { code: { sessionId, createdAt } }
const pairingCodes = new Map();
// sessions: { sessionId: { windowsWs, macWs, clipboardHistory, lastActivity, windowsConnected } }
const sessions = new Map();
// wsToSession: WeakMap to look up session from ws
const wsToSession = new WeakMap();

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

function sendJson(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── REST API ───────────────────────────────────────────────────────────────────

// Windows app requests a pairing code
app.post('/api/request-pairing', (req, res) => {
  cleanExpiredCodes();

  const { sessionId } = req.body;

  // If reconnecting with existing session
  if (sessionId && sessions.has(sessionId)) {
    return res.json({
      success: true,
      sessionId,
      reconnected: true,
      message: 'Reconnected to existing session'
    });
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

  console.log(`[Pairing] Code ${normalizedCode} redeemed → Session: ${sessionId.slice(0, 8)}...`);

  res.json({
    success: true,
    sessionId,
    message: 'Successfully paired! You will now receive clipboard updates from Windows.'
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    pendingCodes: pairingCodes.size
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
  let alive = true;

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
        const session = sessions.get(sessionId);

        if (!session) {
          sendJson(ws, { type: 'error', message: 'Session not found. Please re-pair.' });
          return;
        }

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
        const session = sessions.get(sessionId);
        if (!session) return;

        const item = {
          id: uuidv4(),
          contentType: msg.contentType, // 'text' or 'image'
          content: msg.content,         // text string or base64 image
          mimeType: msg.mimeType || null,
          timestamp: Date.now(),
          size: msg.content ? msg.content.length : 0
        };

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
