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
  const textCache = new Map();

  async function fetchTextById(id) {
    if (textCache.has(id)) {
      return textCache.get(id);
    }
    try {
      const res = await fetch(`/api/clipboard-text/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      textCache.set(id, text);
      return text;
    } catch (err) {
      console.error('[Text] Failed to fetch full text:', err);
      return null;
    }
  }

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
    btnDownloadText: $('btnDownloadText'),
    charCount: $('charCount'),
    contentImage: $('contentImage'),
    imagePreview: $('imagePreview'),
    btnCopyImage: $('btnCopyImage'),
    btnDownloadImage: $('btnDownloadImage'),
    imageSize: $('imageSize'),
    historySection: $('historySection'),
    historyList: $('historyList'),
    btnClearHistory: $('btnClearHistory'),
    btnClearLatest: $('btnClearLatest'),
    btnDisconnect: $('btnDisconnect'),
    btnSoundToggle: $('btnSoundToggle'),
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

  // ─── Sound & Notification Management ───────────────────────────────────────
  const SOUND_KEY = 'clipboardsync_sound';
  let isSoundEnabled = true;
  let audioCtx = null;

  function initSound() {
    const saved = localStorage.getItem(SOUND_KEY);
    isSoundEnabled = saved !== 'off';
    updateSoundButtonUI();

    const btn = document.getElementById('btnSoundToggle');
    if (btn) {
      btn.addEventListener('click', async () => {
        isSoundEnabled = !isSoundEnabled;
        localStorage.setItem(SOUND_KEY, isSoundEnabled ? 'on' : 'off');
        updateSoundButtonUI();

        if (isSoundEnabled) {
          getAudioContext();
          await requestNotificationPermission();
          playNotificationSound();
          showToast('🔔', 'Notification sound on');
        } else {
          showToast('🔕', 'Notification sound muted');
        }
      });
    }

    // Unlock Web Audio on first user gesture anywhere
    const unlockAudio = () => {
      getAudioContext();
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
      document.removeEventListener('touchstart', unlockAudio);
    };
    document.addEventListener('click', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    document.addEventListener('touchstart', unlockAudio);
  }

  function updateSoundButtonUI() {
    const btn = document.getElementById('btnSoundToggle');
    if (!btn) return;
    const onIcon = btn.querySelector('.sound-icon-on');
    const offIcon = btn.querySelector('.sound-icon-off');
    if (isSoundEnabled) {
      btn.classList.remove('muted');
      btn.setAttribute('title', 'Sound & notifications ON (Click to mute)');
      if (onIcon) onIcon.style.display = 'block';
      if (offIcon) offIcon.style.display = 'none';
    } else {
      btn.classList.add('muted');
      btn.setAttribute('title', 'Sound & notifications MUTED (Click to enable)');
      if (onIcon) onIcon.style.display = 'none';
      if (offIcon) offIcon.style.display = 'block';
    }
  }

  function getAudioContext() {
    if (!audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        audioCtx = new AudioCtxClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playNotificationSound() {
    if (!isSoundEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;

      // Tone 1: Gentle modern bell chime
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now); // D5
      osc1.frequency.exponentialRampToValueAtTime(659.25, now + 0.08); // E5

      gain1.gain.setValueAtTime(0.22, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.18);

      // Tone 2: Crisp resonant chime higher pitch
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.08); // A5
      osc2.frequency.exponentialRampToValueAtTime(1046.5, now + 0.15); // C6

      gain2.gain.setValueAtTime(0.0001, now);
      gain2.gain.setValueAtTime(0.28, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.45);

      // Tone 3: Subtle harmonic overtone for warmth
      const osc3 = ctx.createOscillator();
      const gain3 = ctx.createGain();
      osc3.type = 'triangle';
      osc3.frequency.setValueAtTime(1318.5, now + 0.08); // E6
      gain3.gain.setValueAtTime(0.0001, now);
      gain3.gain.setValueAtTime(0.07, now + 0.08);
      gain3.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);

      osc3.connect(gain3);
      gain3.connect(ctx.destination);
      osc3.start(now + 0.08);
      osc3.stop(now + 0.35);
    } catch (err) {
      console.warn('[Audio] Could not play notification chime:', err);
    }
  }

  async function requestNotificationPermission() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission === 'default') {
      try {
        return await Notification.requestPermission();
      } catch (e) {
        return Notification.permission;
      }
    }
    return Notification.permission;
  }

  function showSystemNotification(item) {
    if (!isSoundEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try {
      let title = 'ClipboardSync';
      let body = '';
      if (item.contentType === 'text') {
        title = '📋 New Text Received';
        const raw = item.content || item.preview || '';
        body = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
        if (!body) body = `${(item.size || 0).toLocaleString()} characters from Windows`;
      } else if (item.contentType === 'image') {
        title = '🖼️ New Screenshot Received';
        const sizeStr = item.size ? `${(item.size / 1024).toFixed(1)} KB` : '';
        body = sizeStr ? `Screenshot received from Windows (${sizeStr})` : 'Screenshot received from Windows';
      }

      const notif = new Notification(title, {
        body,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="0.9em" font-size="90">📋</text></svg>',
        tag: 'clipboardsync-latest',
        renotify: true,
        silent: true
      });

      notif.onclick = () => {
        window.focus();
        notif.close();
      };

      setTimeout(() => notif.close(), 6000);
    } catch (err) {
      console.warn('[Notification] Could not display system notification:', err);
    }
  }

  // ─── Initialization ────────────────────────────────────────────────────────
  function init() {
    initTheme();
    initSound();

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

    // Copy & Download actions
    els.btnCopyText.addEventListener('click', () => copyLatestText());
    if (els.btnDownloadText) {
      els.btnDownloadText.addEventListener('click', () => downloadLatestText());
    }
    els.btnCopyImage.addEventListener('click', () => copyLatestImage());
    els.btnDownloadImage.addEventListener('click', () => downloadLatestImage());

    // Clear clipboard data & history
    if (els.btnClearLatest) {
      els.btnClearLatest.addEventListener('click', clearAllClipboard);
    }
    if (els.btnClearHistory) {
      els.btnClearHistory.addEventListener('click', clearAllClipboard);
    }

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
        getAudioContext();
        requestNotificationPermission();
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

        case 'history-cleared':
          clipboardHistory = [];
          textCache.clear();
          renderLatest();
          renderHistory();
          showToast('🗑️', 'Clipboard data cleared');
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

    // Notification chime & system notification
    playNotificationSound();
    showSystemNotification(item);

    // Flash animation
    els.latestCard.classList.remove('new-item', 'highlight');
    // Force reflow
    void els.latestCard.offsetWidth;
    els.latestCard.classList.add('new-item', 'highlight');
    setTimeout(() => els.latestCard.classList.remove('highlight'), 2000);

    // Show toast
    if (item.contentType === 'text') {
      const charCount = item.size !== undefined ? item.size : (item.content ? item.content.length : 0);
      showToast('📋', `Text received (${charCount.toLocaleString()} chars)`);
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

      const totalChars = latest.size !== undefined ? latest.size : (latest.content ? latest.content.length : 0);
      els.charCount.textContent = `${totalChars.toLocaleString()} chars`;

      if (latest.content !== null && latest.content !== undefined) {
        els.textPreview.textContent = latest.content;
      } else if (latest.isLarge && latest.id) {
        els.textPreview.textContent = (latest.preview || '') + '\n\n[Loading complete text (' + totalChars.toLocaleString() + ' chars)...]';
        fetchTextById(latest.id).then((fullText) => {
          if (fullText !== null) {
            latest.content = fullText;
            if (clipboardHistory.length > 0 && clipboardHistory[0].id === latest.id) {
              els.textPreview.textContent = fullText;
              els.charCount.textContent = `${fullText.length.toLocaleString()} chars`;
            }
          }
        });
      } else {
        els.textPreview.textContent = latest.preview || '';
      }
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
      let preview = '';
      if (item.content) {
        preview = item.content.length > 80 ? item.content.slice(0, 80) + '…' : item.content;
      } else if (item.preview) {
        preview = item.preview;
      } else {
        const size = item.size || 0;
        preview = `[Text: ${size.toLocaleString()} characters]`;
      }
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
    copyBtn.addEventListener('click', async () => {
      if (item.contentType === 'text') {
        if (item.content !== null && item.content !== undefined) {
          copyTextToClipboard(item.content, copyBtn);
        } else if (item.isLarge && item.id) {
          copyBtn.disabled = true;
          const fullText = await fetchTextById(item.id);
          copyBtn.disabled = false;
          if (fullText !== null) {
            item.content = fullText;
            copyTextToClipboard(fullText, copyBtn);
          } else {
            showToast('⚠️', 'Failed to load text');
          }
        }
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

    if (latest.content !== null && latest.content !== undefined) {
      await copyTextToClipboard(latest.content, els.btnCopyText);
    } else if (latest.isLarge && latest.id) {
      els.btnCopyText.disabled = true;
      const origHtml = els.btnCopyText.innerHTML;
      els.btnCopyText.innerHTML = '<span class="spinner"></span><span>Loading…</span>';
      const fullText = await fetchTextById(latest.id);
      els.btnCopyText.disabled = false;
      els.btnCopyText.innerHTML = origHtml;
      if (fullText !== null) {
        latest.content = fullText;
        await copyTextToClipboard(fullText, els.btnCopyText);
      } else {
        showToast('⚠️', 'Failed to load text');
      }
    }
  }

  async function downloadLatestText() {
    if (clipboardHistory.length === 0) return;
    const latest = clipboardHistory[0];
    if (latest.contentType !== 'text') return;

    let textToDownload = latest.content;
    if (textToDownload === null || textToDownload === undefined) {
      if (latest.isLarge && latest.id) {
        showToast('⏳', 'Loading text for download…');
        textToDownload = await fetchTextById(latest.id);
      }
    }

    if (typeof textToDownload !== 'string') {
      showToast('⚠️', 'Could not load text for download');
      return;
    }

    const blob = new Blob([textToDownload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `clipboard-text-${Date.now()}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('💾', 'Text downloaded (.txt)');
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

  // ─── Clear All Clipboard Data ──────────────────────────────────────────────
  async function clearAllClipboard() {
    if (clipboardHistory.length === 0) return;
    if (!confirm('Clear all clipboard data and history from server and screen?')) return;

    clipboardHistory = [];
    textCache.clear();
    renderLatest();
    renderHistory();
    showToast('🗑️', 'Clipboard cleared');

    if (sessionId) {
      try {
        await fetch('/api/clear-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
      } catch (err) {
        console.error('[Clear] Server clear failed:', err);
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'clear-history', sessionId }));
      }
    }
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
