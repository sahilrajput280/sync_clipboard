/* ═══════════════════════════════════════════════════════════════════════════════
   ClipboardSync — Windows App Renderer (JavaScript)
   Handles UI state, pairing flow, activity log, and IPC with main process
   ═══════════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const api = window.clipboardSync;

  // ─── State ──────────────────────────────────────────────────────────────────
  let itemsSent = 0;
  let textsSent = 0;
  let imagesSent = 0;
  let activityItems = [];
  let currentView = 'setup';
  const MAX_ACTIVITY = 50;

  // ─── DOM Elements ───────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const els = {
    viewSetup: $('viewSetup'),
    viewPairing: $('viewPairing'),
    viewActive: $('viewActive'),
    serverUrl: $('serverUrl'),
    btnConnect: $('btnConnect'),
    setupError: $('setupError'),
    setupErrorText: $('setupErrorText'),
    codeText: $('codeText'),
    btnNewCode: $('btnNewCode'),
    btnBackSetup: $('btnBackSetup'),
    btnSkipToActive: $('btnSkipToActive'),
    activeDot: $('activeDot'),
    statusLabel: $('statusLabel'),
    activityLog: $('activityLog'),
    statItems: $('statItems'),
    statTexts: $('statTexts'),
    statImages: $('statImages'),
    btnMinToTray: $('btnMinToTray'),
    btnDisconnectActive: $('btnDisconnectActive'),
    toggleAutoLaunch: $('toggleAutoLaunch'),
    btnMinimize: $('btnMinimize'),
    btnClose: $('btnClose'),
  };

  // ─── Initialization ────────────────────────────────────────────────────────
  async function init() {
    setupEventListeners();
    setupIpcListeners();

    const state = await api.getState();

    if (state.isPaired && state.sessionId) {
      showView('active');
      if (state.isConnected) {
        setStatus('connected', 'Connected');
      } else {
        setStatus('reconnecting', 'Connecting…');
      }
    }

    if (state.serverUrl) {
      els.serverUrl.value = state.serverUrl;
    }

    els.toggleAutoLaunch.checked = state.autoLaunch || false;
  }

  // ─── Event Listeners ───────────────────────────────────────────────────────
  function setupEventListeners() {
    // Title bar
    els.btnMinimize.addEventListener('click', () => api.minimizeWindow());
    els.btnClose.addEventListener('click', () => api.closeWindow());

    // Setup
    els.btnConnect.addEventListener('click', handleConnect);
    els.serverUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleConnect();
    });

    // Pairing
    els.btnNewCode.addEventListener('click', handleRequestNewCode);
    els.btnBackSetup.addEventListener('click', () => showView('setup'));
    if (els.btnSkipToActive) {
      els.btnSkipToActive.addEventListener('click', () => showView('active'));
    }

    // Active
    els.btnMinToTray.addEventListener('click', () => api.minimizeToTray());
    els.btnDisconnectActive.addEventListener('click', handleDisconnect);

    // Settings
    els.toggleAutoLaunch.addEventListener('change', (e) => {
      api.setAutoLaunch(e.target.checked);
    });
  }

  // ─── IPC Listeners ────────────────────────────────────────────────────────
  function setupIpcListeners() {
    api.onConnected((data) => {
      setStatus('connected', 'Connected');
      // If we are showing the pairing code to the user, keep it visible!
      if (currentView !== 'pairing') {
        showView('active');
      }
      addActivity('🔗', 'Connected to server');
    });

    api.onMacConnected((data) => {
      showView('active');
      setStatus('connected', 'Mac Connected');
      addActivity('🍏', 'Mac paired successfully!');
    });

    api.onMacDisconnected((data) => {
      addActivity('⚠️', 'Mac disconnected');
    });

    api.onDisconnected(() => {
      setStatus('disconnected', 'Disconnected');
      addActivity('⚡', 'Connection lost');
    });

    api.onReconnecting((data) => {
      setStatus('reconnecting', `Reconnecting… (attempt ${data.attempt})`);
    });

    api.onClipboardSent((data) => {
      itemsSent++;
      els.statItems.textContent = itemsSent;

      if (data.contentType === 'text') {
        textsSent++;
        els.statTexts.textContent = textsSent;
        addActivity('📋', `Text: "${data.preview}"`);
      } else if (data.contentType === 'image') {
        imagesSent++;
        els.statImages.textContent = imagesSent;
        const sizeKb = (data.size / 1024).toFixed(1);
        addActivity('🖼️', `Image sent (${sizeKb} KB)`);
      }
    });

    api.onClipboardError((data) => {
      addActivity('⚠️', data.message);
    });

    api.onError((data) => {
      addActivity('❌', data.message);
    });

    api.onSessionLoaded((data) => {
      showView('active');
      setStatus('reconnecting', 'Reconnecting…');
    });

    api.onReplaced((data) => {
      setStatus('disconnected', 'Replaced by another instance');
      addActivity('⚠️', 'Another Windows instance connected');
    });
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────
  async function handleConnect() {
    const url = els.serverUrl.value.trim();
    if (!url) {
      showSetupError('Please enter a server address.');
      return;
    }

    hideSetupError();
    els.btnConnect.disabled = true;
    els.btnConnect.innerHTML = '<span class="spinner"></span>';

    const urlResult = await api.setServerUrl(url);
    if (!urlResult.success) {
      showSetupError('Invalid server address.');
      els.btnConnect.disabled = false;
      els.btnConnect.innerHTML = '<span>Generate Pairing Code</span>';
      return;
    }

    const result = await api.requestPairing();

    if (result.success && result.code) {
      els.codeText.textContent = result.code;
      showView('pairing');
      // Auto connect WS so it registers and is ready when Mac pairs
      await api.connectWs();
    } else {
      showSetupError(result.error || 'Failed to generate pairing code');
    }

    els.btnConnect.disabled = false;
    els.btnConnect.innerHTML = '<span>Generate Pairing Code</span>';
  }

  async function handleRequestNewCode() {
    els.btnNewCode.disabled = true;
    const result = await api.requestPairing();

    if (result.success && result.code) {
      els.codeText.textContent = result.code;
      await api.connectWs();
    }

    els.btnNewCode.disabled = false;
  }

  async function handleDisconnect() {
    await api.disconnect();
    itemsSent = 0;
    textsSent = 0;
    imagesSent = 0;
    activityItems = [];
    showView('setup');
  }

  // ─── UI Helpers ────────────────────────────────────────────────────────────
  function showView(view) {
    currentView = view;
    els.viewSetup.style.display = view === 'setup' ? '' : 'none';
    els.viewPairing.style.display = view === 'pairing' ? '' : 'none';
    els.viewActive.style.display = view === 'active' ? '' : 'none';
  }

  function setStatus(state, label) {
    els.activeDot.className = 'status-dot';
    if (state === 'connected') {
      els.activeDot.classList.add('connected');
    } else if (state === 'disconnected') {
      els.activeDot.classList.add('disconnected');
    } else if (state === 'reconnecting') {
      els.activeDot.classList.add('reconnecting');
    }
    els.statusLabel.textContent = label;
  }

  function addActivity(icon, text) {
    const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    activityItems.unshift({ icon, text, time });
    if (activityItems.length > MAX_ACTIVITY) {
      activityItems = activityItems.slice(0, MAX_ACTIVITY);
    }

    renderActivityLog();
  }

  function renderActivityLog() {
    if (activityItems.length === 0) {
      els.activityLog.innerHTML = `
        <div class="activity-empty">
          <p>No clipboard activity yet</p>
          <p class="activity-hint">Copy something to see it appear here</p>
        </div>`;
      return;
    }

    els.activityLog.innerHTML = activityItems.map((item) => `
      <div class="activity-item">
        <span class="activity-icon">${item.icon}</span>
        <span class="activity-text">${escapeHtml(item.text)}</span>
        <span class="activity-time">${item.time}</span>
      </div>
    `).join('');
  }

  function showSetupError(msg) {
    els.setupError.style.display = '';
    els.setupErrorText.textContent = msg;
  }

  function hideSetupError() {
    els.setupError.style.display = 'none';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Spinner CSS (injected) ────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 600ms linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);

  // ─── Start ──────────────────────────────────────────────────────────────────
  init();
})();
