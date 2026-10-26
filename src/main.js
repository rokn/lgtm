const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu, nativeTheme } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const { openInEditor } = require('./editor');
const path = require('path');

// Demo runs get a throwaway profile so they never touch (or inherit) the real app's saved filters/token.
if (process.env.LGTM_DEMO) app.setPath('userData', path.join(require('os').tmpdir(), 'lgtm-demo-profile-' + process.pid));

const tokenFile = () => path.join(app.getPath('userData'), 'token.bin');

function readStored() {
  try {
    const buf = fs.readFileSync(tokenFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch { return null; }
}

function ghCliToken() {
  // GUI apps get a minimal PATH on macOS/Linux; add the usual install locations.
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/home/linuxbrew/.linuxbrew/bin'];
  const env = { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(path.delimiter) };
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { env, timeout: 5000 }, (err, out) => resolve(err ? null : out.trim() || null));
  });
}

ipcMain.handle('token:get', async () => {
  const stored = readStored();
  if (stored) return { token: stored, source: 'saved' };
  const gh = await ghCliToken();
  return gh ? { token: gh, source: 'gh' } : { token: null };
});
ipcMain.handle('token:set', (_e, token) => {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token);
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), data, { mode: 0o600 });
});
ipcMain.handle('editor:open', (_e, o) => openInEditor(o, app.getPath('userData')));
ipcMain.handle('focus', () => { const w = BrowserWindow.getAllWindows()[0]; if (!w) return; if (w.isMinimized()) w.restore(); w.show(); w.focus(); });
ipcMain.handle('badge', (_e, n) => { try { app.setBadgeCount(Math.max(0, n | 0)); } catch {} });
ipcMain.handle('demo', () => !!process.env.LGTM_DEMO);
ipcMain.handle('token:clear', () => { try { fs.unlinkSync(tokenFile()); } catch {} });
ipcMain.handle('open:external', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    title: 'LGTM',
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (process.env.LGTM_SHOTS) win.webContents.once('did-finish-load', () => takeShots(win, process.env.LGTM_SHOTS));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Dev helper: LGTM_DEMO=1 LGTM_SHOTS=docs/screenshots npm start  -> renders the demo data and saves PNGs.
async function takeShots(win, dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (js) => { const r = await win.webContents.executeJavaScript(`(async () => { try { ${js}; } catch (e) { return 'ERR ' + e.stack; } })()`); if (typeof r === 'string' && r.startsWith('ERR')) console.error('shot step failed:', js.slice(0, 60), r); };
  const shot = async (name) => { win.setContentSize(1400, 900); await wait(600); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  win.setContentSize(1400, 900); await wait(1500);
  await run(`S.sel = 1; updateList()`); await shot('list');
  await run(`openPR(S.shown.find((p) => p.number === 1284))`); await wait(800);
  await run(`S.d.cur = 'internal/server/middleware.go'; updateFiles()`); await shot('review');
  await run(`openDrawer('conv')`); await shot('comments');
  await run(`openDrawer('links')`); await shot('links'); await run(`closeDrawer()`);
  await run(`openPalette(); const i = $('#pq'); i.value = 'idempotency'; i.dispatchEvent(new Event('input'))`); await shot('search');
  await run(`closePalette(); S.d.cur = 'internal/ratelimit/limiter.go'; updateFiles(); openFind(); $('#fq').value = 'bucket'; S.find.q = 'bucket'; updateFind(false)`); await shot('find');
  app.quit();
}

app.whenReady().then(() => {
  if (process.env.LGTM_SHOTS) nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
