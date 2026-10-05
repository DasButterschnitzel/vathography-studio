// Desktop shell (Windows, also macOS and Linux): the web app in an Electron window.
// The files are served from a private app:// origin, because ES modules, workers
// and IndexedDB do not work on file://.
const { app, BrowserWindow, protocol, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const WWW = path.join(__dirname, 'www');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 720, minHeight: 520,
    backgroundColor: '#0b0b0c', title: 'Vathography Studio', show: false,
    icon: path.join(WWW, 'icons', 'icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  // links (README, Hugging Face, …) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    if (i.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (i.key === 'F12' || (i.control && i.shift && i.key.toLowerCase() === 'i')) { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.loadURL('app://studio/index.html');
}

app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.whenReady().then(() => {
  // no menu bar: the studio has its own shortcuts (Ctrl+Z, Ctrl+S, Ctrl+E…)
  Menu.setApplicationMenu(null);
  protocol.handle('app', async (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.join(WWW, path.normalize(rel === '/' ? '/index.html' : rel));
    if (!file.startsWith(WWW + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      return new Response(await fs.promises.readFile(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
