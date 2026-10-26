'use strict';
// Open a PR file in the user's editor: finds the local clone, makes sure the right commit is checked out
// (via a throwaway git worktree if needed), then launches a GUI editor or a terminal editor (vim/nvim/helix).
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32', isMac = process.platform === 'darwin';
const env = () => ({
  ...process.env, GIT_TERMINAL_PROMPT: '0',
  PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/home/linuxbrew/.linuxbrew/bin', path.join(os.homedir(), '.local/bin'),
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin', '/Applications/Cursor.app/Contents/Resources/app/bin', '/Applications/Zed.app/Contents/MacOS']
    .filter(Boolean).join(path.delimiter),
});
const run = (cmd, args, opts = {}) => new Promise((res, rej) =>
  execFile(cmd, args, { env: env(), timeout: opts.timeout || 15000, cwd: opts.cwd, maxBuffer: 1 << 20 }, (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out.trim()))));
const spawnDetached = (cmd, args, opts = {}) => new Promise((res, rej) => {
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', env: env(), ...opts });
  c.once('error', rej); c.once('spawn', () => { c.unref(); res(); });
});
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX shell quoting
const expand = (p) => p.trim().replace(/^~(?=$|[\\/])/, os.homedir());

const GUI = {
  code: { name: 'VS Code', bin: 'code', args: (f, l) => ['-g', `${f}:${l}`], macApp: 'Visual Studio Code' },
  cursor: { name: 'Cursor', bin: 'cursor', args: (f, l) => ['-g', `${f}:${l}`], macApp: 'Cursor' },
  zed: { name: 'Zed', bin: 'zed', args: (f, l) => [`${f}:${l}`], macApp: 'Zed' },
  subl: { name: 'Sublime Text', bin: 'subl', args: (f, l) => [`${f}:${l}`], macApp: 'Sublime Text' },
  idea: { name: 'IntelliJ IDEA', bin: 'idea', args: (f, l) => ['--line', String(l), f] },
};
const TUI = {
  vim: { name: 'Vim', cmd: (f, l) => ['vim', `+${l}`, f] },
  nvim: { name: 'Neovim', cmd: (f, l) => ['nvim', `+${l}`, f] },
  hx: { name: 'Helix', cmd: (f, l) => ['hx', `${f}:${l}`] },
};

/* ---- locate the local clone of owner/repo ---- */
const cache = new Map();
function remotesOf(dir) {
  try {
    const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'); const out = []; let cur = null;
    for (const line of cfg.split('\n')) {
      const h = /^\[remote "(.+)"\]/.exec(line.trim()); if (h) { cur = h[1]; continue; }
      if (/^\[/.test(line.trim())) cur = null;
      const u = cur && /^url\s*=\s*(.+)$/.exec(line.trim()); if (u) out.push({ remote: cur, url: u[1] });
    }
    return out;
  } catch { return []; }
}
function findRepo(nwo, roots) {
  const want = nwo.toLowerCase(), hit = cache.get(want);
  if (hit && fs.existsSync(path.join(hit.dir, '.git'))) return hit;
  const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'Library', 'AppData']);
  const scan = (dir, depth) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      for (const { remote, url } of remotesOf(dir)) {
        const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
        if (m && `${m[1]}/${m[2]}`.toLowerCase() === want) return { dir, remote };
      }
      return null; // don't descend into repos
    }
    if (depth === 0) return null;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const r = scan(path.join(dir, e.name), depth - 1); if (r) return r;
    }
    return null;
  };
  for (const root of roots) { const r = scan(root, 3); if (r) { cache.set(want, r); return r; } }
  return null;
}

/* ---- make sure the PR's commit is what the editor sees ---- */
async function resolveDir(repo, { nwo, number, headOid }, userData) {
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: repo.dir }).catch(() => '');
  if (head === headOid) return { dir: repo.dir, note: 'your checkout' };
  const wt = path.join(userData, 'worktrees', `${nwo.replace('/', '__')}-pr${number}`);
  try {
    if (fs.existsSync(wt) && (await run('git', ['rev-parse', 'HEAD'], { cwd: wt }).catch(() => '')) === headOid) return { dir: wt, note: 'PR worktree' };
    const have = await run('git', ['cat-file', '-e', `${headOid}^{commit}`], { cwd: repo.dir }).then(() => true, () => false);
    if (!have) await run('git', ['fetch', repo.remote, `pull/${number}/head`], { cwd: repo.dir, timeout: 90000 });
    if (fs.existsSync(wt)) await run('git', ['checkout', '--detach', headOid], { cwd: wt });
    else { fs.mkdirSync(path.dirname(wt), { recursive: true }); await run('git', ['worktree', 'add', '--detach', wt, headOid], { cwd: repo.dir, timeout: 90000 }); }
    return { dir: wt, note: 'PR worktree' };
  } catch (e) {
    return { dir: repo.dir, note: `⚠ your checkout is not on the PR commit and the PR could not be fetched (${e.message.split('\n')[0].slice(0, 80)})` };
  }
}

/* ---- launching ---- */
async function launchTerminal(termKey, dir, cmd) {
  const line = `cd ${q(dir)} && ${cmd.map(q).join(' ')}`;
  const asEsc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  if (isMac) {
    if (termKey === 'iterm') return run('osascript', ['-e', 'tell application "iTerm"', '-e', 'activate', '-e', 'create window with default profile', '-e', `tell current session of current window to write text "${asEsc(line)}"`, '-e', 'end tell']);
    if (termKey === 'ghostty') return spawnDetached('open', ['-na', 'Ghostty', '--args', '-e', 'sh', '-c', line]);
    if (termKey === 'kitty') return spawnDetached('kitty', ['sh', '-c', line]);
    if (termKey === 'alacritty') return spawnDetached('alacritty', ['-e', 'sh', '-c', line]);
    if (termKey === 'wezterm') return spawnDetached('wezterm', ['start', '--', 'sh', '-c', line]);
    return run('osascript', ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${asEsc(line)}"`, '-e', 'end tell']);
  }
  if (isWin) {
    try { return await spawnDetached('wt.exe', ['-d', dir, ...cmd]); }
    catch { return spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd', '/k', `cd /d "${dir}" && ${cmd.map((a) => `"${a}"`).join(' ')}`], { windowsVerbatimArguments: true }); }
  }
  const table = {
    gnome: ['gnome-terminal', ['--', 'sh', '-c', line]], konsole: ['konsole', ['-e', 'sh', '-c', line]], kitty: ['kitty', ['sh', '-c', line]],
    alacritty: ['alacritty', ['-e', 'sh', '-c', line]], wezterm: ['wezterm', ['start', '--', 'sh', '-c', line]], xterm: ['xterm', ['-e', 'sh', '-c', line]],
  };
  const order = table[termKey] ? [termKey] : ['default', 'gnome', 'konsole', 'kitty', 'alacritty', 'wezterm', 'xterm'];
  for (const k of order) {
    const [bin, args] = k === 'default' ? ['x-terminal-emulator', ['-e', 'sh', '-c', line]] : table[k];
    try { return await spawnDetached(bin, args); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error('No terminal emulator found — pick one in settings');
}

async function openInEditor(o, userData) {
  const nwo = String(o.nwo || ''), file = String(o.file || ''), line = Math.max(1, parseInt(o.line, 10) || 1);
  const number = parseInt(o.number, 10), headOid = String(o.headOid || '');
  const cfg = o.settings || {};
  if (!/^[\w.-]+\/[\w.-]+$/.test(nwo) || !file || !number || !/^[0-9a-f]{40}$/.test(headOid)) return { ok: false, msg: 'Missing PR details' };
  const roots = String(cfg.roots || '').split(/[,\n]/).map(expand).filter(Boolean);
  let dir, note, target;
  const repo = findRepo(nwo, roots.length ? roots : [os.homedir()]);
  if (repo) {
    ({ dir, note } = await resolveDir(repo, { nwo, number, headOid }, userData));
    target = path.resolve(dir, file);
    if (!target.startsWith(path.resolve(dir) + path.sep)) return { ok: false, msg: 'Refusing to open a path outside the repo' };
    if (!fs.existsSync(target)) return { ok: false, msg: `File not found in ${dir}` };
  } else {
    if (typeof o.content !== 'string') return { ok: false, reason: 'no-clone', msg: `No local clone of ${nwo} found under: ${roots.join(', ') || '~'}` };
    dir = path.join(userData, 'snapshots', nwo.replace('/', '__'), `pr${number}`);
    target = path.resolve(dir, file);
    if (!target.startsWith(dir + path.sep)) return { ok: false, msg: 'Bad file path' };
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, o.content);
    note = 'read-only snapshot of the PR version — no local clone found';
  }
  const ed = cfg.editor || 'code';
  try {
    if (GUI[ed]) {
      const g = GUI[ed];
      try { await spawnDetached(g.bin, g.args(target, line), { cwd: dir }); }
      catch (e) { if (e.code === 'ENOENT' && isMac && g.macApp) await spawnDetached('open', ['-a', g.macApp, '--args', ...g.args(target, line)]); else throw e; }
      return { ok: true, msg: `Opened in ${g.name} (${note})` };
    }
    if (TUI[ed]) { await launchTerminal(cfg.terminal || 'default', dir, TUI[ed].cmd(target, line)); return { ok: true, msg: `Opened in ${TUI[ed].name} (${note})` }; }
    if (ed === 'custom') {
      if (!cfg.custom || !cfg.custom.trim()) return { ok: false, msg: 'Custom command is empty — set it in settings' };
      const cmd = cfg.custom.replace(/\{file\}/g, q(target)).replace(/\{line\}/g, String(line)).replace(/\{dir\}/g, q(dir));
      await spawnDetached(cmd, [], { shell: true, cwd: dir });
      return { ok: true, msg: `Ran custom editor command (${note})` };
    }
    return { ok: false, msg: 'Unknown editor: ' + ed };
  } catch (e) {
    return { ok: false, msg: `Could not launch ${ed}: ${e.code === 'ENOENT' ? 'command not found (is it on your PATH?)' : e.message}` };
  }
}
module.exports = { openInEditor };
