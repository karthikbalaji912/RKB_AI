/* ==========================================================================
   RKB Desktop — Preload (contextBridge)
   --------------------------------------------------------------------------
   Exposes ONLY a small, validated API to the renderer.
   No Node primitives are exposed.
   ========================================================================== */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rkbDesktop", {
  isDesktop: true,
  // Window controls
  setAlwaysOnTop: (v) => ipcRenderer.invoke("rkb:setAlwaysOnTop", !!v),
  setClickThrough: (v) => ipcRenderer.invoke("rkb:setClickThrough", !!v),
  setOpacity: (v) => ipcRenderer.invoke("rkb:setOpacity", Number(v)),
  setScale: (v) => ipcRenderer.invoke("rkb:setScale", Number(v)),
  snap: (corner) => ipcRenderer.invoke("rkb:snap", String(corner)),
  show: () => ipcRenderer.invoke("rkb:show"),
  hide: () => ipcRenderer.invoke("rkb:hide"),
  minimize: () => ipcRenderer.invoke("rkb:minimize"),
  setHotkey: (k) => ipcRenderer.invoke("rkb:setHotkey", String(k || "")),
  setDisplayMode: (m) => ipcRenderer.invoke("rkb:setDisplayMode", String(m)),
  getState: () => ipcRenderer.invoke("rkb:state"),

  // Actions (ALLOWLISTED on the main process)
  requestAction: (action, params) => ipcRenderer.invoke("rkb:action", String(action), params || {}),

  // Events from main
  onInit: (cb) => ipcRenderer.on("rkb:init", (_, state) => cb && cb(state)),
  onState: (cb) => ipcRenderer.on("rkb:state", (_, state) => cb && cb(state)),
  onHotkey: (cb) => ipcRenderer.on("rkb:hotkey", (_, k) => cb && cb(k)),
  onNav: (cb) => ipcRenderer.on("rkb:nav", (_, s) => cb && cb(s))
});