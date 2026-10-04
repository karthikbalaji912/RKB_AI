/* ==========================================================================
   RKB Desktop — Electron main process
   --------------------------------------------------------------------------
   Loads the existing RKB web UI from http://localhost:5000
   Adds: always-on-top, click-through, opacity, scale, tray, global hotkey,
   snap-to-corner, position memory, allowlisted OS actions.

   SECURITY: contextIsolation: true, nodeIntegration: false.
   Renderer only talks to main via preload.js contextBridge.
   ========================================================================== */
"use strict";

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, shell, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const SERVER = path.join(ROOT, "server.js");
const LOGO = path.join(ROOT, "logo.png");
const PORT = process.env.PORT || 5000;

let win = null;
let tray = null;
let serverProc = null;
const stateFile = path.join(app.getPath("userData"), "rkb-desktop-state.json");

const DEFAULT_STATE = {
  bounds: { x: 40, y: 40, width: 1280, height: 820 },
  alwaysOnTop: true,
  clickThrough: false,
  opacity: 1,
  scale: 1,
  displayMode: "full",
  hotkey: "Ctrl+Space",
  visible: true
};

function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; }
  catch { return { ...DEFAULT_STATE }; }
}
function saveState(patch) {
  const cur = loadState();
  const next = { ...cur, ...patch };
  try { fs.writeFileSync(stateFile, JSON.stringify(next, null, 2)); } catch {}
  return next;
}

/* ---------- Local server auto-launch ---------- */
function startServerIfNeeded() {
  // ping /api/health; if not up, spawn `node server.js`
  const http = require("http");
  const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => { res.resume(); loadUI(); });
  req.on("error", () => {
    if (!fs.existsSync(SERVER)) { loadUI(); return; }
    try {
      serverProc = spawn(process.platform === "win32" ? "node.exe" : "node", [SERVER], {
        cwd: ROOT, stdio: "ignore", windowsHide: true
      });
      serverProc.on("error", () => loadUI());
      setTimeout(loadUI, 1200);
    } catch { loadUI(); }
  });
  req.setTimeout(1200, () => { try { req.destroy(); } catch {} });
}

/* ---------- Window ---------- */
function createWindow() {
  const s = loadState();
  win = new BrowserWindow({
    x: s.bounds.x, y: s.bounds.y,
    width: s.bounds.width, height: s.bounds.height,
    minWidth: 380, minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: !!s.alwaysOnTop,
    resizable: true,
    skipTaskbar: false,
    icon: fs.existsSync(LOGO) ? nativeImage.createFromPath(LOGO) : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  win.setOpacity(clamp(s.opacity, 0.2, 1));
  if (s.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(!!s.alwaysOnTop, "floating");

  // Close → hide (tray keeps app alive)
  win.on("close", (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); saveState({ visible: false }); }
  });
  win.on("move", saveBounds);
  win.on("resize", saveBounds);

  return win;
}
function saveBounds() {
  if (!win) return;
  const b = win.getBounds();
  saveState({ bounds: b });
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function loadUI() {
  if (!win) createWindow();
  win.loadURL(`http://127.0.0.1:${PORT}/`).catch(() => {
    if (fs.existsSync(INDEX)) win.loadFile(INDEX);
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("rkb:init", loadState());
  });
}

/* ---------- Tray ---------- */
function buildTray() {
  let icon = null;
  try { icon = fs.existsSync(LOGO) ? nativeImage.createFromPath(LOGO).resize({ width: 16, height: 16 }) : null; } catch {}
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("RKB — Real-Time Knowledge Buddy AI");
  refreshTrayMenu();
  tray.on("double-click", () => toggleWindow());
}
function refreshTrayMenu() {
  if (!tray) return;
  const s = loadState();
  const menu = Menu.buildFromTemplate([
    { label: "Show RKB", click: () => { win.show(); win.focus(); saveState({ visible: true }); } },
    { label: "Hide RKB", click: () => { win.hide(); saveState({ visible: false }); } },
    { type: "separator" },
    { label: "Always On Top", type: "checkbox", checked: !!s.alwaysOnTop, click: (item) => {
      const next = saveState({ alwaysOnTop: item.checked });
      win.setAlwaysOnTop(!!next.alwaysOnTop, "floating");
      win.webContents.send("rkb:state", next);
    }},
    { label: "Click Through", type: "checkbox", checked: !!s.clickThrough, click: (item) => {
      const next = saveState({ clickThrough: item.checked });
      win.setIgnoreMouseEvents(!!next.clickThrough, { forward: true });
      win.webContents.send("rkb:state", next);
    }},
    { label: "Full UI", type: "radio", checked: s.displayMode === "full", click: () => setDisplayMode("full") },
    { label: "Companion", type: "radio", checked: s.displayMode === "companion", click: () => setDisplayMode("companion") },
    { label: "HUD", type: "radio", checked: s.displayMode === "hud", click: () => setDisplayMode("hud") },
    { type: "separator" },
    { label: "Snap Top Left", click: () => snap("tl") },
    { label: "Snap Top Right", click: () => snap("tr") },
    { label: "Snap Bottom Left", click: () => snap("bl") },
    { label: "Snap Bottom Right", click: () => snap("br") },
    { type: "separator" },
    { label: "Open Studio", click: () => { win.show(); win.focus(); win.webContents.send("rkb:nav", "head"); } },
    { label: "Open Settings", click: () => { win.show(); win.focus(); win.webContents.send("rkb:nav", "desktop"); } },
    { type: "separator" },
    { label: "Quit RKB", click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}
function setDisplayMode(mode) {
  saveState({ displayMode: mode });
  if (mode === "companion") {
    win.setSize(420, 520);
    win.setResizable(true);
  } else if (mode === "hud") {
    win.setSize(360, 160);
  } else if (mode === "full") {
    const s = loadState();
    win.setSize(s.bounds.width || 1280, s.bounds.height || 820);
  }
  if (win) win.webContents.send("rkb:state", loadState());
  refreshTrayMenu();
}

/* ---------- Snap ---------- */
function snap(corner) {
  if (!win) return;
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const { x: sx, y: sy } = display.workArea;
  const [w, h] = win.getSize();
  const pad = 12;
  let x = sx + pad, y = sy + pad;
  if (corner === "tr") x = sx + sw - w - pad;
  else if (corner === "bl") y = sy + sh - h - pad;
  else if (corner === "br") { x = sx + sw - w - pad; y = sy + sh - h - pad; }
  win.setPosition(x, y);
  saveBounds();
}

/* ---------- Hotkey ---------- */
function registerHotkey(combo) {
  globalShortcut.unregisterAll();
  if (!combo) return false;
  const ok = globalShortcut.register(combo, () => {
    if (!win) return;
    if (win.isVisible()) { win.hide(); saveState({ visible: false }); }
    else { win.show(); win.focus(); saveState({ visible: true }); }
    win.webContents.send("rkb:hotkey", "hotkey-pressed");
  });
  return ok;
}

/* ---------- Toggle ---------- */
function toggleWindow() { if (!win) return; win.isVisible() ? win.hide() : win.show(); }

/* ---------- IPC bridge ---------- */
ipcMain.handle("rkb:setAlwaysOnTop", (e, v) => { saveState({ alwaysOnTop: !!v }); if (win) win.setAlwaysOnTop(!!v, "floating"); refreshTrayMenu(); return true; });
ipcMain.handle("rkb:setClickThrough", (e, v) => { saveState({ clickThrough: !!v }); if (win) win.setIgnoreMouseEvents(!!v, { forward: true }); refreshTrayMenu(); return true; });
ipcMain.handle("rkb:setOpacity", (e, v) => { const o = clamp(Number(v) || 1, 0.2, 1); saveState({ opacity: o }); if (win) win.setOpacity(o); return true; });
ipcMain.handle("rkb:setScale", (e, v) => { const s = clamp(Number(v) || 1, 0.5, 1.5); saveState({ scale: s }); return true; });
ipcMain.handle("rkb:snap", (e, c) => { if (c === "restore") { const st = loadState(); win.setBounds(st.bounds); return true; } snap(c); return true; });
ipcMain.handle("rkb:show", () => { if (win) { win.show(); win.focus(); saveState({ visible: true }); } return true; });
ipcMain.handle("rkb:hide", () => { if (win) { win.hide(); saveState({ visible: false }); } return true; });
ipcMain.handle("rkb:minimize", () => { if (win) win.minimize(); return true; });
ipcMain.handle("rkb:setHotkey", (e, k) => { saveState({ hotkey: k }); return registerHotkey(k); });
ipcMain.handle("rkb:setDisplayMode", (e, m) => { setDisplayMode(m); return true; });
ipcMain.handle("rkb:state", () => loadState());

ipcMain.handle("rkb:action", async (e, action, params) => {
  // STRICT allowlist. Never trust the renderer.
  const ALLOW = new Set(["OPEN_URL","OPEN_APP","OPEN_FOLDER","COPY_TEXT","READ_TEXT","CREATE_NOTE","START_TIMER"]);
  if (!ALLOW.has(action)) return false;
  try {
    if (action === "OPEN_URL") {
      const url = String(params?.url || "");
      if (!/^https?:\/\//i.test(url)) return false;
      await shell.openExternal(url);
      return true;
    }
    if (action === "OPEN_APP") {
      // Only allow a small set of safe apps
      const name = String(params?.name || "").toLowerCase();
      const safe = ["notepad","calculator","calc","explorer","paint","code"];
      if (!safe.includes(name)) return false;
      shell.openExternal(`file://${name}`); // best-effort; on Windows use spawn
      try {
        if (process.platform === "win32") spawn("cmd", ["/c", "start", "", name], { windowsHide: true });
        else if (process.platform === "darwin") spawn("open", ["-a", name]);
        else spawn(name);
      } catch {}
      return true;
    }
    if (action === "OPEN_FOLDER") {
      const p = String(params?.path || "").replace(/[^\w .:\/\\~-]/g, "");
      if (!p) return false;
      const resolved = p.startsWith("~") ? p.replace("~", app.getPath("home")) : p;
      await shell.openPath(resolved);
      return true;
    }
    if (action === "COPY_TEXT" || action === "READ_TEXT" || action === "CREATE_NOTE" || action === "START_TIMER") {
      // handled client-side (clipboard, memory, timer)
      return true;
    }
  } catch (err) {
    console.error("[RKB] action error:", err);
    return false;
  }
  return false;
});

/* ---------- Lifecycle ---------- */
app.on("window-all-closed", (e) => { /* keep alive for tray */ });
app.whenReady().then(() => {
  app.setAppUserModelId("ai.rkb.companion");
  app.isQuitting = false;
  createWindow();
  buildTray();
  const st = loadState();
  if (st.hotkey) registerHotkey(st.hotkey);
  startServerIfNeeded();
  refreshTrayMenu();
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (serverProc) { try { serverProc.kill(); } catch {} }
});