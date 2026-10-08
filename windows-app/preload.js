/* ═══════════════════════════════════════════════════════════════════════════════
   ClipboardSync — Preload Script (Context Bridge)
   Safely exposes IPC methods to renderer process
   ═══════════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipboardSync', {
  // ── State ────────────────────────────────────────────────────────────────
  getState: () => ipcRenderer.invoke('get-state'),

  // ── Pairing ──────────────────────────────────────────────────────────────
  setServerUrl: (url) => ipcRenderer.invoke('set-server-url', url),
  requestPairing: () => ipcRenderer.invoke('request-pairing'),
  connectWs: () => ipcRenderer.invoke('connect-ws'),
  disconnect: () => ipcRenderer.invoke('disconnect'),

  // ── Window Controls ──────────────────────────────────────────────────────
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // ── Settings ─────────────────────────────────────────────────────────────
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  setMinimizeToTray: (enabled) => ipcRenderer.invoke('set-minimize-to-tray', enabled),

  // ── Event Listeners ──────────────────────────────────────────────────────
  onConnected: (callback) => ipcRenderer.on('connected', (_, data) => callback(data)),
  onDisconnected: (callback) => ipcRenderer.on('disconnected', (_, data) => callback(data)),
  onReconnecting: (callback) => ipcRenderer.on('reconnecting', (_, data) => callback(data)),
  onMonitoring: (callback) => ipcRenderer.on('monitoring', (_, data) => callback(data)),
  onClipboardSent: (callback) => ipcRenderer.on('clipboard-sent', (_, data) => callback(data)),
  onClipboardError: (callback) => ipcRenderer.on('clipboard-error', (_, data) => callback(data)),
  onError: (callback) => ipcRenderer.on('error', (_, data) => callback(data)),
  onSessionLoaded: (callback) => ipcRenderer.on('session-loaded', (_, data) => callback(data)),
  onReplaced: (callback) => ipcRenderer.on('replaced', (_, data) => callback(data)),
  onMacConnected: (callback) => ipcRenderer.on('mac-connected', (_, data) => callback(data)),
  onMacDisconnected: (callback) => ipcRenderer.on('mac-disconnected', (_, data) => callback(data)),
});
