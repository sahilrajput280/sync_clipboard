/* ═══════════════════════════════════════════════════════════════════════════════
   ClipboardSync — Mac Web Application (JavaScript)
   Handles pairing, WebSocket connection, real-time clipboard display, history
   ═══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────────────────────
  const WS_RECONNECT_DELAY_MS = 2000;
  const WS_MAX_RECONNECT_DELAY = 30000;
  const TOAST_DURATION = 2500;
  const STORAGE_KEY = 'clipboardsync_session';

  // ─── State ──────────────────────────────────────────────────────────────────
  let ws = null;
  let sessionId = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let clipboardHistory = [];
  let isWindowsConnected = false;
  let toastTimer = null;

  // ─── DOM Elements ───────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const els = {
    viewPairing: $('viewPairing'),
    viewClipboard: $('viewClipboard'),
    connectionBadge: $('connectionBadge'),
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    pairingCode: $('pairingCode'),
    pairingHint: $('pairingHint'),
    pairingError: $('pairingError'),
    pairingErrorText: $('pairingErrorText'),
    btnPair: $('btnPair'),
    pulseDot: $('pulseDot'),
    latestMeta: $('latestMeta'),
    metaType: $('metaType'),
    metaTime: $('metaTime'),
    latestCard: $('latestCard'),
    emptyState: $('emptyState'),
    contentText: $('contentText'),
    textPreview: $('textPreview'),
    btnCopyText: $('btnCopyText'),
    charCount: $('charCount'),
    contentImage: $('contentImage'),
    imagePreview: $('imagePreview'),
    btnCopyImage: $('btnCopyImage'),
    btnDownloadImage: $('btnDownloadImage'),
    imageSize: $('imageSize'),
    historySection: $('historySection'),
    historyList: $('historyList'),
    btnClearHistory: $('btnClearHistory'),
    btnDisconnect: $('btnDisconnect'),
    toast: $('toast'),
    toastIcon: $('toastIcon'),
    toastMsg: $('toastMsg'),
  };

  // ─── Theme Management ───────────────────────────────────────────────────────
  const THEME_KEY = 'clipboardsync_theme';
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    setTheme(theme);

    const btn = document.getElementById('btnThemeToggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        setTheme(next);
      });
    }
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }

  // ─── Initialization ────────────────────────────────────────────────────────
  function init() {
    initTheme();

    // Check for saved session
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        if (data.sessionId) {
          sessionId = data.sessionId;
          showClipboardView();
          connectWebSocket();
          return;
        }
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    showPairingView();
    setupEventListeners();
  }

  // ─── Event Listeners ───────────────────────────────────────────────────────
  function setupEventListeners() {
    // Pairing
    els.btnPair.addEventListener('click', handlePair);
    els.pairingCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePair();
    });
    els.pairingCode.addEventListener('input', formatPairingInput);

    // Copy actions
    els.btnCopyText.addEventListener('click', () => copyLatestText());
    els.btnCopyImage.addEventListener('click', () => copyLatestImage());
    els.btnDownloadImage.addEventListener('click', () => downloadLatestImage());

    // History
    els.btnClearHistory.addEventListener('click', clearHistory);

    // Disconnect
    els.btnDisconnect.addEventListener('click', handleDisconnect);
  }

  // ─── Pairing ────────────────────────────────────────────────────────────────
  function formatPairingInput(e) {
    let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (val.length > 4) {
      val = val.slice(0, 4) + '-' + val.slice(4, 8);
    }
    e.target.value = val;
    hidePairingError();
  }

  async function handlePair() {
    const code = els.pairingCode.value.trim();
    if (!code || code.length < 9) {
      showPairingError('Please enter a valid 8-character pairing code.');
      return;
    }

    els.btnPair.disabled = true;
    els.btnPair.innerHTML = '<span class="spinner"></span><span>Connecting…</span>';

    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });

      const data = await res.json();

      if (data.success) {
        sessionId = data.sessionId;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId }));
        showToast('✅', 'Paired successfully!');
        showClipboardView();
        connectWebSocket();
      } else {
        showPairingError(data.error || 'Pairing failed. Please try again.');
      }
    } catch (err) {
      showPairingError('Could not connect to server. Check your network connection.');
    }

    els.btnPair.disabled = false;
    els.btnPair.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      <span>Connect</span>`;
  }

  function showPairingError(msg) {
    els.pairingError.style.display = 'flex';
    els.pairingErrorText.textContent = msg;
    els.pairingCode.classList.add('error');
  }

  function hidePairingError() {
    els.pairingError.style.display = 'none';
    els.pairingCode.classList.remove('error');
  }

  // ─── Views ──────────────────────────────────────────────────────────────────
  function showPairingView() {
    els.viewPairing.style.display = '';
    els.viewClipboard.style.display = 'none';
    updateConnectionBadge('pairing');
    setupEventListeners();
  }

  function showClipboardView() {
    els.viewPairing.style.display = 'none';
    els.viewClipboard.style.display = '';
    setupEventListeners();
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────────
  function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[WS] Connected');
      reconnectAttempts = 0;

      // Register as Mac
      ws.send(JSON.stringify({
        type: 'register',
        sessionId,
        role: 'mac'
      }));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'registered':
          isWindowsConnected = msg.windowsConnected || false;
          updateConnectionBadge(isWindowsConnected ? 'connected' : 'waiting');

          // Load history from server
          if (msg.history && msg.history.length > 0) {
            clipboardHistory = msg.history;
            renderLatest();
            renderHistory();
          }
          break;

        case 'clipboard':
          handleNewClipboard(msg.item);
          break;

        case 'windows-status':
          isWindowsConnected = msg.connected;
          updateConnectionBadge(isWindowsConnected ? 'connected' : 'disconnected');
          if (msg.connected) {
            showToast('🔗', 'Windows connected');
          } else {
            showToast('⚡', 'Windows disconnected');
          }
          break;

        case 'error':
          showToast('⚠️', msg.message);
          break;

        case 'replaced':
          // Another Mac connected; close gracefully
          ws.close();
          break;
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      if (sessionId) {
        updateConnectionBadge('reconnecting');
        scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = Math.min(WS_RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts), WS_MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    console.log(`[WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => connectWebSocket(), delay);
  }

  // ─── Connection Badge ──────────────────────────────────────────────────────
  function updateConnectionBadge(state) {
    els.statusDot.className = 'status-dot';

    switch (state) {
      case 'connected':
        els.statusDot.classList.add('connected');
        els.statusText.textContent = 'Windows Connected';
        els.pulseDot.classList.remove('inactive');
        break;
      case 'disconnected':
        els.statusDot.classList.add('disconnected');
        els.statusText.textContent = 'Windows Offline';
        els.pulseDot.classList.add('inactive');
        break;
      case 'waiting':
        els.statusDot.classList.add('pairing');
        els.statusText.textContent = 'Waiting for Windows…';
        els.pulseDot.classList.add('inactive');
        break;
      case 'reconnecting':
        els.statusDot.classList.add('pairing');
        els.statusText.textContent = 'Reconnecting…';
        break;
      case 'pairing':
        els.statusText.textContent = 'Not paired';
        break;
    }
  }

  // ─── Clipboard Handling ────────────────────────────────────────────────────
  function handleNewClipboard(item) {
    // Add to local history
    clipboardHistory.unshift(item);
    if (clipboardHistory.length > 20) {
      clipboardHistory = clipboardHistory.slice(0, 20);
    }

    renderLatest();
    renderHistory();

    // Flash animation
    els.latestCard.classList.remove('new-item', 'highlight');
    // Force reflow
    void els.latestCard.offsetWidth;
    els.latestCard.classList.add('new-item', 'highlight');
    setTimeout(() => els.latestCard.classList.remove('highlight'), 2000);

    // Show toast
    if (item.contentType === 'text') {
      const preview = item.content.length > 40 ? item.content.slice(0, 40) + '…' : item.content;
      showToast('📋', `Text received: "${preview}"`);
    } else {
      showToast('🖼️', 'Image received');
    }
  }

  function renderLatest() {
    if (clipboardHistory.length === 0) {
      els.emptyState.style.display = '';
      els.contentText.style.display = 'none';
      els.contentImage.style.display = 'none';
      els.latestMeta.style.display = 'none';
      return;
    }

    const latest = clipboardHistory[0];
    els.emptyState.style.display = 'none';
    els.latestMeta.style.display = 'flex';
    els.metaTime.textContent = formatTime(latest.timestamp);

    if (latest.contentType === 'text') {
      els.metaType.textContent = 'Text';
      els.contentText.style.display = '';
      els.contentImage.style.display = 'none';
      els.textPreview.textContent = latest.content;
      els.charCount.textContent = `${latest.content.length.toLocaleString()} chars`;
    } else if (latest.contentType === 'image') {
      els.metaType.textContent = 'Image';
      els.contentText.style.display = 'none';
      els.contentImage.style.display = 'block';
      const imgSrc = latest.content
        ? `data:${latest.mimeType || 'image/png'};base64,${latest.content}`
        : `/api/clipboard-image/${latest.id}`;
      els.imagePreview.src = imgSrc;
      els.imageSize.textContent = formatBytes(latest.size || 0);
    }
  }

  function renderHistory() {
    if (clipboardHistory.length <= 1) {
      els.historySection.style.display = 'none';
      return;
    }

    els.historySection.style.display = '';
    els.historyList.innerHTML = '';

    // Show items starting from index 1 (skip latest)
    const items = clipboardHistory.slice(1, 11); // show up to 10 history items
    items.forEach((item, idx) => {
      const el = createHistoryItem(item, idx);
      els.historyList.appendChild(el);
    });
  }

  function createHistoryItem(item, index) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.style.animationDelay = `${index * 50}ms`;

    const iconSvg = item.contentType === 'text'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;

    let contentHtml;
    if (item.contentType === 'text') {
      const preview = item.content.length > 80 ? item.content.slice(0, 80) + '…' : item.content;
      contentHtml = `<span class="history-text">${escapeHtml(preview)}</span>`;
    } else {
      const thumbSrc = item.content
        ? `data:${item.mimeType || 'image/png'};base64,${item.content}`
        : `/api/clipboard-image/${item.id}`;
      contentHtml = `<img class="history-image-thumb" src="${thumbSrc}" alt="Image">`;
    }

    div.innerHTML = `
      <div class="history-type-icon">${iconSvg}</div>
      <div class="history-content">
        ${contentHtml}
        <div class="history-time">${formatTime(item.timestamp)}</div>
      </div>
      <div class="history-actions">
        <button class="history-copy-btn" title="Copy" data-item-id="${item.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>`;

    // Copy button handler
    const copyBtn = div.querySelector('.history-copy-btn');
    copyBtn.addEventListener('click', () => {
      if (item.contentType === 'text') {
        copyTextToClipboard(item.content, copyBtn);
      } else {
        copyImageToClipboard(item, copyBtn);
      }
    });

    return div;
  }

  // ─── Copy Actions ──────────────────────────────────────────────────────────
  async function copyLatestText() {
    if (clipboardHistory.length === 0) return;
    const latest = clipboardHistory[0];
    if (latest.contentType !== 'text') return;
    await copyTextToClipboard(latest.content, els.btnCopyText);
  }

  async function copyLatestImage() {
    if (clipboardHistory.length === 0) return;
    const latest = clipboardHistory[0];
    if (latest.contentType !== 'image') return;
    await copyImageToClipboard(latest, els.btnCopyImage);
  }

  function downloadLatestImage() {
    if (clipboardHistory.length === 0) return;
    const latest = clipboardHistory[0];
    if (latest.contentType !== 'image') return;

    const link = document.createElement('a');
    link.href = latest.content
      ? `data:${latest.mimeType || 'image/png'};base64,${latest.content}`
      : `/api/clipboard-image/${latest.id}`;
    const ext = (latest.mimeType && latest.mimeType.includes('jpeg')) ? 'jpg' : 'png';
    link.download = `clipboard-image-${Date.now()}.${ext}`;
    link.click();
    showToast('💾', 'Image downloaded');
  }

  async function copyTextToClipboard(text, btnEl) {
    try {
      await navigator.clipboard.writeText(text);
      animateCopyButton(btnEl);
      showToast('✅', 'Copied to clipboard');
    } catch (err) {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      animateCopyButton(btnEl);
      showToast('✅', 'Copied to clipboard');
    }
  }

  async function copyImageToClipboard(item, btnEl) {
    try {
      let blob;
      if (item.content) {
        const byteChars = atob(item.content);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArray[i] = byteChars.charCodeAt(i);
        }
        blob = new Blob([byteArray], { type: item.mimeType || 'image/png' });
      } else {
        const res = await fetch(`/api/clipboard-image/${item.id}`);
        blob = await res.blob();
      }

      // Convert to PNG blob if needed because macOS Safari & Chrome require image/png for ClipboardItem
      if (blob.type !== 'image/png') {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      }

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);
      animateCopyButton(btnEl);
      showToast('✅', 'Image copied to clipboard');
    } catch (err) {
      console.error('Failed to copy image:', err);
      showToast('⚠️', 'Could not copy image. Try downloading instead.');
    }
  }

  function animateCopyButton(btnEl) {
    if (!btnEl) return;
    btnEl.classList.add('copied');
    const origHTML = btnEl.innerHTML;
    // For the main copy buttons
    if (btnEl.querySelector('span')) {
      const spanEl = btnEl.querySelector('span');
      spanEl.textContent = 'Copied!';
    }
    setTimeout(() => {
      btnEl.classList.remove('copied');
      if (btnEl.querySelector('span')) {
        btnEl.innerHTML = origHTML;
      }
    }, 1500);
  }

  // ─── History ────────────────────────────────────────────────────────────────
  function clearHistory() {
    if (clipboardHistory.length <= 1) return;
    const latest = clipboardHistory[0];
    clipboardHistory = [latest];
    renderHistory();
    showToast('🗑️', 'History cleared');
  }

  // ─── Disconnect ─────────────────────────────────────────────────────────────
  function handleDisconnect() {
    if (!confirm('Disconnect from this Windows computer? You will need to pair again.')) return;

    sessionId = null;
    clipboardHistory = [];
    isWindowsConnected = false;
    localStorage.removeItem(STORAGE_KEY);

    if (ws) {
      ws.close();
      ws = null;
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    showPairingView();
    showToast('👋', 'Disconnected');
  }

  // ─── Toast ──────────────────────────────────────────────────────────────────
  function showToast(icon, msg) {
    if (toastTimer) clearTimeout(toastTimer);
    els.toastIcon.textContent = icon;
    els.toastMsg.textContent = msg;
    els.toast.classList.add('visible');
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), TOAST_DURATION);
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────
  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 5) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;

    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Time updater ──────────────────────────────────────────────────────────
  setInterval(() => {
    if (clipboardHistory.length > 0) {
      els.metaTime.textContent = formatTime(clipboardHistory[0].timestamp);
    }
  }, 30000); // update time display every 30s

  // ─── Start ──────────────────────────────────────────────────────────────────
  init();
})();
