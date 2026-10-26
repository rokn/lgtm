const { app, BrowserWindow, ipcMain, safeStorage, shell, Menu } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

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
ipcMain.handle('token:clear', () => { try { fs.unlinkSync(tokenFile()); } catch {} });
ipcMain.handle('open:external', (_e, url) => {
  if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
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
