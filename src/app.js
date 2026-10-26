'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = (k, d) => { try { const v = localStorage.getItem('sp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lset = (k, v) => { try { localStorage.setItem('sp.' + k, JSON.stringify(v)); } catch {} };
if (native.platform === 'darwin') document.body.classList.add('mac');

const S = {
  hideTests: ls('hideTests', true),
  token: null, view: 'login', prs: [], sel: 0, loading: false,
  source: ls('source', 'review'), q: ls('q', ''), sort: ls('sort', 'updated'),
  d: null, // PR detail state
  shown: [], // PRs currently visible in list
};
const SOURCES = [['review', 'Review requested'], ['mine', 'Mine'], ['involved', 'Involved'], ['orgs', 'All in my orgs']];
const SORTS = ['updated', 'created', 'size', 'repo'];
const CHIPS = [['merge:ready', 'Ready to merge'], ['merge:behind', 'Needs update'], ['merge:auto', 'Auto-merging'], ['merge:conflict', 'Conflicts'], ['-is:draft', 'Hide drafts'], ['is:approved', 'Approved'], ['is:changes', 'Changes requested'], ['is:unreviewed', 'Needs review'], ['ci:fail', 'CI failing']];

/* ---------- helpers ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), Math.max(2200, msg.length * 70)); }
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now';
  const m = s / 60, h = m / 60, d = h / 24;
  return m < 60 ? `${Math.floor(m)}m` : h < 24 ? `${Math.floor(h)}h` : d < 30 ? `${Math.floor(d)}d` : `${Math.floor(d / 30)}mo`;
}
const ghOpen = (u) => native.openExternal(u);

async function gql(query, variables) {
  if (S.token === 'demo') return {};
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST', headers: { Authorization: 'bearer ' + S.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status === 401) { await native.clearToken(); S.token = null; S.view = 'login'; render(); throw new Error('Unauthorized'); }
  const j = await r.json();
  if (!j.data) throw new Error((j.errors || [{ message: j.message || 'GitHub error ' + r.status }]).map((e) => e.message).join('; '));
  return j.data;
}
async function rest(path) {
  const r = await fetch('https://api.github.com' + path, { headers: { Authorization: 'Bearer ' + S.token, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return r.json();
}

/* ---------- data: PR list ---------- */
const PR_FIELDS = `id number title bodyText url isDraft mergeable mergeStateStatus autoMergeRequest { enabledAt } createdAt updatedAt additions deletions changedFiles reviewDecision
  author { login avatarUrl(size: 44) } repository { nameWithOwner }
  labels(first: 5) { nodes { name color } } comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
const SEARCH = `query($q:String!,$after:String){ search(query:$q,type:ISSUE,first:100,after:$after){ pageInfo{hasNextPage endCursor} nodes{ ... on PullRequest { ${PR_FIELDS} } } } }`;

async function searchPRs(q) {
  let after = null; const out = [];
  for (let i = 0; i < 3; i++) {
    const s = (await gql(SEARCH, { q, after })).search;
    out.push(...s.nodes.filter((n) => n && n.id));
    if (!s.pageInfo.hasNextPage) break;
    after = s.pageInfo.endCursor;
  }
  return out;
}
async function queriesFor(source) {
  const base = 'is:pr is:open archived:false';
  if (source === 'review') return [`${base} review-requested:@me`];
  if (source === 'mine') return [`${base} author:@me`];
  if (source === 'involved') return [`${base} involves:@me`];
  const d = await gql('{ viewer { login organizations(first:50){nodes{login}} } }');
  return [`${base} user:${d.viewer.login}`, ...d.viewer.organizations.nodes.map((o) => `${base} org:${o.login}`)];
}
async function loadPRs() {
  if (S.token === 'demo') { S.prs = DEMO.prs; S.loading = false; return updateList(); }
  S.loading = true; updateList();
  try {
    const qs = await queriesFor(S.source);
    const all = (await Promise.all(qs.map(searchPRs))).flat();
    S.prs = [...new Map(all.map((p) => [p.id, p])).values()];
  } catch (e) { toast('Load failed: ' + e.message); }
  S.loading = false; updateList();
}

/* ---------- list filtering ---------- */
function parseQuery(q) {
  return q.trim().split(/\s+/).filter(Boolean).map((t) => {
    const neg = t.startsWith('-'); if (neg) t = t.slice(1);
    const i = t.indexOf(':');
    return i > 0 ? { neg, key: t.slice(0, i).toLowerCase(), val: t.slice(i + 1).toLowerCase() } : { neg, key: '', val: t.toLowerCase() };
  });
}
// Where is this PR on its way to merged?
function mergeKind(p) {
  if (p.autoMergeRequest) return 'auto';
  if (p.isDraft) return null;
  if (p.mergeable === 'CONFLICTING' || p.mergeStateStatus === 'DIRTY') return 'conflict';
  if (p.mergeStateStatus === 'BEHIND') return 'behind';
  if (p.mergeable === 'MERGEABLE' && ['CLEAN', 'HAS_HOOKS'].includes(p.mergeStateStatus)) return 'ready';
  if (p.mergeStateStatus === 'BLOCKED') return 'blocked';
  return null;
}
const MERGE_BADGE = { auto: ['b-auto', '⏳ Auto-merge on'], conflict: ['b-bad', 'Conflicts'], behind: ['b-warn', '↻ Needs update'], ready: ['b-ok', '✓ Ready to merge'], blocked: ['b-draft', 'Blocked'] };
const ci = (p) => p.commits.nodes[0]?.commit.statusCheckRollup?.state;
function matches(p, terms) {
  return terms.every(({ neg, key, val }) => {
    let ok;
    const hay = `${p.repository.nameWithOwner} #${p.number} ${p.title} ${p.author?.login}`.toLowerCase();
    if (key === 'repo') ok = p.repository.nameWithOwner.toLowerCase().includes(val);
    else if (key === 'author') ok = (p.author?.login || '').toLowerCase().includes(val);
    else if (key === 'label') ok = p.labels.nodes.some((l) => l.name.toLowerCase().includes(val));
    else if (key === 'ci') ok = { fail: ['FAILURE', 'ERROR'], pass: ['SUCCESS'], pending: ['PENDING', 'EXPECTED'] }[val]?.includes(ci(p)) ?? false;
    else if (key === 'merge') ok = mergeKind(p) === val;
    else if (key === 'is') ok = { draft: p.isDraft, ready: !p.isDraft, approved: p.reviewDecision === 'APPROVED', changes: p.reviewDecision === 'CHANGES_REQUESTED', unreviewed: p.reviewDecision === 'REVIEW_REQUIRED' || !p.reviewDecision }[val] ?? false;
    else ok = hay.includes(val);
    return neg ? !ok : ok;
  });
}
const SORT_FN = {
  updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
  created: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  size: (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  repo: (a, b) => a.repository.nameWithOwner.localeCompare(b.repository.nameWithOwner) || b.number - a.number,
};
function toggleToken(tok) {
  const parts = S.q.split(/\s+/).filter(Boolean);
  const i = parts.indexOf(tok);
  if (i >= 0) parts.splice(i, 1); else parts.push(tok);
  setQuery(parts.join(' '));
}
function setQuery(q) { S.q = q; lset('q', q); const inp = $('#q'); if (inp && inp.value !== q) inp.value = q; S.sel = 0; updateList(); }
function toggleRepo(name) {
  const parts = S.q.split(/\s+/).filter((t) => t && !t.startsWith('repo:'));
  if (!S.q.split(/\s+/).includes('repo:' + name)) parts.push('repo:' + name);
  setQuery(parts.join(' '));
}

/* ---------- list view ---------- */
function mountList() {
  $('#app').innerHTML = `
  <div class="top">
    <div class="seg">${SOURCES.map(([k, l], i) => `<button data-src="${k}" title="${i + 1}">${l}</button>`).join('')}</div>
    <div class="grow"><input id="q" placeholder="Filter…  repo:foo  author:bar  label:bug  merge:ready  -is:draft  ci:fail   ( / )" value="${esc(S.q)}"></div>
    <button id="sortb"></button><button id="refresh" title="r">⟳ Refresh</button><button id="help-b">?</button>
  </div>
  <div class="chips" id="chips"></div>
  <div class="body"><div class="side" id="side"></div><div class="main" id="prs"></div></div>
  <div class="foot"><span><kbd>j</kbd><kbd>k</kbd> move</span><span><kbd>⏎</kbd> review files</span><span><kbd>o</kbd> open on GitHub</span><span><kbd>⇧M</kbd> smart merge</span><span><kbd>⇧U</kbd> update branch</span><span><kbd>m</kbd> merge filter</span><span><kbd>/</kbd> filter</span><span><kbd>1</kbd>–<kbd>4</kbd> source</span><span><kbd>s</kbd> sort</span><span><kbd>?</kbd> all shortcuts</span><span id="count" style="margin-left:auto"></span></div>`;
  $('#q').addEventListener('input', (e) => { S.q = e.target.value; lset('q', S.q); S.sel = 0; updateList(); });
}
function listClick(e) {
  const t = e.target.closest('[data-src],[data-chip],[data-repo],[data-pr],#refresh,#sortb,#help-b'); if (!t || S.view !== 'list') return;
  if (t.dataset.src) { setSource(t.dataset.src); }
  else if (t.dataset.chip) toggleToken(t.dataset.chip);
  else if (t.dataset.repo) toggleRepo(t.dataset.repo);
  else if (t.dataset.pr != null) { S.sel = +t.dataset.pr; openPR(S.shown[S.sel]); }
  else if (t.id === 'refresh') loadPRs();
  else if (t.id === 'sortb') cycleSort();
  else if (t.id === 'help-b') toggleHelp();
}
function setSource(k) { S.source = k; lset('source', k); S.prs = []; loadPRs(); }
function cycleSort() { S.sort = SORTS[(SORTS.indexOf(S.sort) + 1) % SORTS.length]; lset('sort', S.sort); updateList(); }

function updateList() {
  if (S.view !== 'list' || !$('#prs')) return;
  const terms = parseQuery(S.q);
  S.shown = S.prs.filter((p) => matches(p, terms)).sort(SORT_FN[S.sort]);
  S.sel = Math.max(0, Math.min(S.sel, S.shown.length - 1));
  document.querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === S.source));
  $('#sortb').textContent = 'Sort: ' + S.sort;
  const parts = S.q.split(/\s+/);
  $('#chips').innerHTML = '<span style="color:var(--muted)">Quick:</span>' + CHIPS.map(([t, l]) => `<button class="chip ${parts.includes(t) ? 'on' : ''}" data-chip="${t}">${l}</button>`).join('');
  // repo facets ignore the current repo: filter so they stay clickable
  const noRepo = parseQuery(S.q).filter((t) => t.key !== 'repo');
  const counts = {}; S.prs.filter((p) => matches(p, noRepo)).forEach((p) => { counts[p.repository.nameWithOwner] = (counts[p.repository.nameWithOwner] || 0) + 1; });
  $('#side').innerHTML = '<h4>Repositories</h4>' + Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) =>
    `<div class="item ${parts.includes('repo:' + n.toLowerCase()) || parts.includes('repo:' + n) ? 'on' : ''}" data-repo="${esc(n)}"><span title="${esc(n)}">${esc(n)}</span><span class="cnt">${c}</span></div>`).join('');
  const main = $('#prs');
  if (S.loading && !S.prs.length) main.innerHTML = '<div class="spin">Loading pull requests…</div>';
  else if (!S.shown.length) main.innerHTML = `<div class="empty">${S.prs.length ? 'No PRs match this filter.' : 'No open PRs here 🎉'}</div>`;
  else main.innerHTML = S.shown.map(prRow).join('');
  $('#count').textContent = `${S.shown.length} of ${S.prs.length} PRs${S.loading ? ' · refreshing…' : ''}`;
  main.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function prRow(p, i) {
  const rd = { APPROVED: ['b-ok', 'Approved'], CHANGES_REQUESTED: ['b-bad', 'Changes requested'], REVIEW_REQUIRED: ['b-warn', 'Review required'] }[p.reviewDecision];
  const st = ci(p); const dot = st === 'SUCCESS' ? 'ok' : st === 'FAILURE' || st === 'ERROR' ? 'bad' : st ? 'pend' : '';
  return `<div class="pr ${i === S.sel ? 'sel' : ''}" data-pr="${i}">
    <img src="${esc(p.author?.avatarUrl || '')}" alt="">
    <div><div><span class="t">${esc(p.title)}</span></div>
      <div class="meta"><span>${esc(p.repository.nameWithOwner)} #${p.number}</span><span>${esc(p.author?.login || 'ghost')}</span>
        ${p.isDraft ? '<span class="badge b-draft">Draft</span>' : ''}${MERGE_BADGE[mergeKind(p)] ? `<span class="badge ${MERGE_BADGE[mergeKind(p)][0]}">${MERGE_BADGE[mergeKind(p)][1]}</span>` : ''}${rd ? `<span class="badge ${rd[0]}">${rd[1]}</span>` : ''}
        ${p.labels.nodes.map((l) => `<span class="label" style="background:#${esc(l.color)}">${esc(l.name)}</span>`).join('')}</div></div>
    <div class="right"><div>${dot ? `<span class="dot ${dot}"></span> ` : ''}<span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span> · ${p.changedFiles} files</div>
      <div>${p.comments.totalCount ? '💬 ' + p.comments.totalCount + ' · ' : ''}updated ${ago(p.updatedAt)} ago</div></div></div>`;
}


/* ---------- find + selection highlighting ---------- */
const HL_PRIO = { sel: 0, find: 1, cur: 2 };
function setHL(name, ranges) {
  if (!window.CSS || !CSS.highlights) return;
  if (!ranges.length) { CSS.highlights.delete(name); return; }
  const h = new Highlight(...ranges); h.priority = HL_PRIO[name]; CSS.highlights.set(name, h);
}
function rangesFor(term, caseSensitive) {
  const out = []; const box = $('#diff'); if (!term || !box) return out;
  const t = caseSensitive ? term : term.toLowerCase();
  const locate = (nodes, off, end) => { for (const x of nodes) { const len = x.n.data.length; if (end ? off > x.start && off <= x.start + len : off >= x.start && off < x.start + len) return [x.n, off - x.start]; } return null; };
  box.querySelectorAll('td.c').forEach((td) => {
    const nodes = []; let txt = ''; const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { nodes.push({ n, start: txt.length }); txt += n.data; }
    const hay = caseSensitive ? txt : txt.toLowerCase();
    for (let i = hay.indexOf(t, 1); i >= 0; i = hay.indexOf(t, i + t.length)) {
      const a = locate(nodes, i, false), b = locate(nodes, i + t.length, true); if (!a || !b) continue;
      const r = new Range(); r.setStart(...a); r.setEnd(...b); out.push(r);
    }
  });
  return out;
}
function countPatch(f, term) {
  const t = term.toLowerCase(); let c = 0;
  for (const l of (f.patch || '').split('\n')) {
    if (!l || l[0] === '@' || l[0] === '\\') continue;
    const h = l.slice(1).toLowerCase();
    for (let i = h.indexOf(t); i >= 0; i = h.indexOf(t, i + t.length)) c++;
  }
  return c;
}
function refreshHighlights() {
  const F = S.find;
  if (!F || !F.open || !F.q) { setHL('find', []); setHL('cur', []); updateSelHL(); return; }
  const rs = rangesFor(F.q, false); setHL('find', rs);
  const f = curFile(); const r = F.target && f && F.target.file === f.filename ? rs[F.target.nth] : null;
  setHL('cur', r ? [r] : []);
  if (r && F.scroll) r.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  F.scroll = false; updateSelHL();
}
function findCounts() {
  const F = S.find; const cf = curFile();
  const files = F.scope === 'file' ? [cf].filter(Boolean) : visibleFiles();
  return files.map((f) => ({ f, c: f === cf ? rangesFor(F.q, false).length : countPatch(f, F.q) }));
}
function showFindCount() {
  const F = S.find; const el = $('#fcount'); if (!el) return;
  $('#fscope').textContent = F.scope === 'all' ? 'All files' : 'This file';
  if (!F.q) { el.textContent = ''; return; }
  if (!F.total) { el.textContent = 'No results'; return; }
  let pos = 0; for (const x of F.counts) { if (F.target && x.f.filename === F.target.file) { pos += F.target.nth + 1; break; } pos += x.c; }
  el.textContent = `${pos}/${F.total} · ${F.counts.filter((x) => x.c).length} file${F.counts.filter((x) => x.c).length === 1 ? '' : 's'}`;
}
function updateFind(keepTarget) {
  const F = S.find;
  if (!F.q) { F.counts = []; F.total = 0; F.target = null; }
  else {
    F.counts = findCounts(); F.total = F.counts.reduce((a, x) => a + x.c, 0);
    if (!keepTarget) { const cf = curFile(); const hit = F.counts.find((x) => x.f === cf && x.c) || F.counts.find((x) => x.c); F.target = hit ? { file: hit.f.filename, nth: 0 } : null; F.scroll = true; }
  }
  refreshHighlights(); showFindCount();
}
function stepFind(dir) {
  const F = S.find; if (!F.q || !F.total) return;
  if (!F.target) return updateFind(false);
  let pos = 0; for (const x of F.counts) { if (x.f.filename === F.target.file) { pos += F.target.nth; break; } pos += x.c; }
  pos = (pos + dir + F.total) % F.total;
  for (const x of F.counts) { if (pos < x.c) { F.target = { file: x.f.filename, nth: pos }; break; } pos -= x.c; }
  F.scroll = true;
  if (F.target.file !== S.d.cur) { S.d.cur = F.target.file; updateFiles(); } else refreshHighlights();
  showFindCount();
}
function openFind() {
  const F = S.find; F.open = true; $('#findbar').hidden = false;
  const sel = getSelection()?.toString() || '';
  if (sel && !/\n/.test(sel) && sel.length <= 100) F.q = sel;
  const inp = $('#fq'); inp.value = F.q; inp.focus(); inp.select(); updateFind(false);
}
function closeFind() {
  const F = S.find; F.open = false; $('#findbar').hidden = true; refreshHighlights(); document.activeElement?.blur();
}
function toggleScope() { const F = S.find; F.scope = F.scope === 'all' ? 'file' : 'all'; lset('fscope', F.scope); updateFind(false); }
let selRaf;
function updateSelHL() {
  const sel = getSelection(); let txt = '';
  if (S.view === 'pr' && sel && !sel.isCollapsed && $('#diff')?.contains(sel.anchorNode)) txt = sel.toString();
  if (/\n/.test(txt) || txt.trim().length < 2 || txt.length > 100) txt = '';
  setHL('sel', txt ? rangesFor(txt, true) : []);
}
document.addEventListener('selectionchange', () => { cancelAnimationFrame(selRaf); selRaf = requestAnimationFrame(updateSelHL); });

/* ---------- syntax highlighting ---------- */
const LANG_ALIAS = { tsx: 'typescript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', vue: 'xml', html: 'xml', svelte: 'xml', yml: 'yaml', h: 'c', hpp: 'cpp', tf: 'ini', toml: 'ini', zsh: 'bash', sh: 'bash', dockerfile: 'dockerfile', kt: 'kotlin' };
function langFor(path) {
  if (typeof hljs === 'undefined') return null;
  const base = path.split('/').pop().toLowerCase(); const ext = base.includes('.') ? base.split('.').pop() : base;
  const l = LANG_ALIAS[ext] || ext; return hljs.getLanguage(l) ? l : null;
}
function hl(code, lang) {
  if (!lang || !code) return esc(code);
  try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { return esc(code); }
}

/* ---------- PR detail ---------- */
async function openPR(pr) {
  if (!pr) return;
  S.view = 'pr';
  S.d = { pr, files: [], cur: null, loading: true, filter: ls('ff', ''), hideViewed: false, prId: pr.id, hist: [] };
  mountPR(); updateFiles();
  if (S.token === 'demo') { S.d.files = DEMO.files(); S.d.loading = false; return updateFiles(); }
  try {
    const nwo = pr.repository.nameWithOwner;
    const restFiles = (async () => { const out = []; for (let p = 1; p <= 30; p++) { const r = await rest(`/repos/${nwo}/pulls/${pr.number}/files?per_page=100&page=${p}`); out.push(...r); if (r.length < 100) break; } return out; })();
    const viewed = (async () => {
      const [owner, name] = nwo.split('/'); const map = {}; let after = null;
      for (let i = 0; i < 30; i++) {
        const pg = (await gql(`query($o:String!,$n:String!,$num:Int!,$a:String){repository(owner:$o,name:$n){pullRequest(number:$num){ id headRefOid files(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}} }}}`, { o: owner, n: name, num: pr.number, a: after })).repository.pullRequest;
        if (S.d) { S.d.prId = pg.id; S.d.headOid = pg.headRefOid; }
        pg.files.nodes.forEach((f) => { map[f.path] = f.viewerViewedState; });
        if (!pg.files.pageInfo.hasNextPage) break; after = pg.files.pageInfo.endCursor;
      }
      return map;
    })();
    const [files, vmap] = await Promise.all([restFiles, viewed]);
    if (S.d?.pr !== pr) return;
    S.d.files = files.map((f) => ({ ...f, viewed: vmap[f.filename] === 'VIEWED', stale: vmap[f.filename] === 'DISMISSED' }));
  } catch (e) { toast('Failed to load files: ' + e.message); }
  if (S.d?.pr !== pr) return;
  S.d.loading = false; updateFiles();
}
function mountPR() {
  const p = S.d.pr; S.find = { open: false, q: '', scope: ls('fscope', 'all'), counts: [], total: 0, target: null };
  $('#app').innerHTML = `
  <div class="top"><button id="back" title="Esc">← Back</button>
    <div class="ptitle">${esc(p.repository.nameWithOwner)} <span style="color:var(--muted)">#${p.number}</span> ${esc(p.title)}</div>
    <button id="prev">[ prev PR</button><button id="next">next PR ]</button><button id="closepr" title="X">Close PR <kbd>⇧X</kbd></button><button id="merge" title="M">Smart merge <kbd>M</kbd></button><button id="gh">Open on GitHub</button><button id="help-b">?</button></div>
  <div class="body">
    <div class="files"><div class="fhead">
      <input id="ff" placeholder="Filter files: *.ts  src/  !*.lock  ( / )" value="${esc(S.d.filter)}">
      <div id="folders" class="chips" style="padding:0;border:0"></div>
      <div class="progress"><div id="bar"></div></div>
      <div style="display:flex;flex-wrap:wrap;gap:2px 12px;color:var(--muted);font-size:12px"><span id="prog" style="flex-basis:100%"></span>
        <label style="cursor:pointer"><input type="checkbox" id="ht" style="vertical-align:middle"> hide tests <kbd>t</kbd></label>
        <label style="cursor:pointer"><input type="checkbox" id="hv" style="vertical-align:middle"> hide viewed <kbd>h</kbd></label></div>
    </div><div class="flist" id="flist"></div></div>
    <div class="diffwrap"><div class="dhead" id="dhead"></div>
      <div id="findbar" hidden><input id="fq" placeholder="Find in PR…" spellcheck="false"><span id="fcount"></span><button id="fscope" title="Tab"></button><button id="fprev" title="Shift+Enter">↑</button><button id="fnext" title="Enter">↓</button><button id="fclose" title="Esc">✕</button></div><div class="diff" id="diff"></div></div>
  </div>
  <div class="foot"><span><kbd>j</kbd><kbd>k</kbd> next/prev file</span><span><kbd>Space</kbd>/<kbd>⏎</kbd> viewed + next</span><span><kbd>n</kbd><kbd>p</kbd> next/prev unviewed</span><span><kbd>Ctrl+D</kbd><kbd>Ctrl+U</kbd> scroll</span><span><kbd>u</kbd> undo</span><span><kbd>e</kbd> expand file</span><span><kbd>/</kbd> filter</span><span><kbd>[</kbd><kbd>]</kbd> other PR</span><span><kbd>Esc</kbd> back</span></div>`;
  $('#ff').addEventListener('input', (e) => { S.d.filter = e.target.value; lset('ff', S.d.filter); updateFiles(); });
  $('#fq').addEventListener('input', (e) => { S.find.q = e.target.value; updateFind(false); });
  $('#ht').checked = S.hideTests;
  $('#ht').addEventListener('change', (e) => { S.hideTests = e.target.checked; lset('hideTests', S.hideTests); updateFiles(); });
  $('#hv').addEventListener('change', (e) => { S.d.hideViewed = e.target.checked; updateFiles(); });
}
function prClick(e) {
  if (S.view !== 'pr') return;
  const t = e.target.closest('[data-f],[data-dir],#back,#prev,#next,#gh,#merge,#eb,#closepr,#fscope,#fprev,#fnext,#fclose,#help-b,#vb,[data-chk]'); if (!t) return;
  if (t.dataset.chk != null) { e.stopPropagation(); const f = visibleFiles()[+t.dataset.chk]; if (f) setViewed(f, !f.viewed); return; }
  if (t.dataset.f != null) { S.d.cur = visibleFiles()[+t.dataset.f]?.filename; updateFiles(); }
  else if (t.dataset.dir) { S.d.filter = e.shiftKey ? `${S.d.filter} !${t.dataset.dir}`.trim() : t.dataset.dir; $('#ff').value = S.d.filter; lset('ff', S.d.filter); updateFiles(); }
  else if (t.id === 'back') back();
  else if (t.id === 'prev') otherPR(-1);
  else if (t.id === 'next') otherPR(1);
  else if (t.id === 'eb') toggleExpand();
  else if (t.id === 'fscope') toggleScope();
  else if (t.id === 'fprev') stepFind(-1);
  else if (t.id === 'fnext') stepFind(1);
  else if (t.id === 'fclose') closeFind();
  else if (t.id === 'closepr') closePR(S.d.pr);
  else if (t.id === 'merge') smartMerge(S.d.pr);
  else if (t.id === 'gh') ghOpen(S.d.pr.url + '/files');
  else if (t.id === 'help-b') toggleHelp();
  else if (t.id === 'vb') { const f = curFile(); if (f) toggleViewedAdvance(f); }
}
function back() { S.view = 'list'; S.d = null; mountList(); updateList(); }
function otherPR(dir) {
  const i = S.shown.findIndex((p) => p.id === S.d.pr.id) + dir;
  if (i < 0 || i >= S.shown.length) return toast(dir > 0 ? 'Last PR in list' : 'First PR in list');
  S.sel = i; openPR(S.shown[i]);
}

function fileMatcher(filter) {
  const toks = filter.split(/[\s,]+/).filter(Boolean).map((t) => {
    const neg = t.startsWith('!'); if (neg) t = t.slice(1);
    t = t.toLowerCase();
    const re = t.includes('*') ? new RegExp(t.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*'), 'i') : null;
    return { neg, test: (path) => { path = path.toLowerCase(); return re ? (re.test(path) || re.test(path.split('/').pop())) : path.includes(t); } };
  });
  const inc = toks.filter((t) => !t.neg), exc = toks.filter((t) => t.neg);
  return (path) => (!inc.length || inc.some((t) => t.test(path))) && !exc.some((t) => t.test(path));
}
const TEST_RE = /(^|\/)(tests?|__tests__|__mocks__|__snapshots__|specs?|e2e|cypress|fixtures|testdata)\/|\.(test|spec|stories)\.[^/]+$|_test\.(go|py|rb|rs|exs?)$|(^|\/)test_[^/]*\.py$|(Test|Tests|Spec|IT)\.(java|kt|cs|scala|swift)$|\.snap$/i;
const isTest = (path) => TEST_RE.test(path);
function visibleFiles() {
  const d = S.d; const m = fileMatcher(d.filter);
  return d.files.filter((f) => m(f.filename) && !(d.hideViewed && f.viewed) && !(S.hideTests && isTest(f.filename)));
}
const curFile = () => visibleFiles().find((f) => f.filename === S.d.cur);

function updateFiles() {
  const d = S.d; if (!d || S.view !== 'pr' || !$('#flist')) return;
  const vis = visibleFiles();
  if (!vis.some((f) => f.filename === d.cur)) d.cur = vis[0]?.filename ?? null;
  const done = d.files.filter((f) => f.viewed).length;
  $('#prog').textContent = d.loading ? 'Loading files…' : `${done}/${d.files.length} viewed${vis.length !== d.files.length ? ` · ${vis.length} shown` : ''}${S.hideTests && d.files.some((f) => isTest(f.filename)) ? ` · ${d.files.filter((f) => isTest(f.filename)).length} tests hidden` : ''}`;
  $('#bar').style.width = d.files.length ? (done / d.files.length) * 100 + '%' : '0';
  const dirs = {}; d.files.forEach((f) => { const p = f.filename.split('/'); if (p.length > 1) dirs[p[0] + '/'] = (dirs[p[0] + '/'] || 0) + 1; });
  $('#folders').innerHTML = Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, c]) => `<button class="chip" data-dir="${esc(k)}" title="shift-click to exclude">${esc(k)} ${c}</button>`).join('');
  $('#flist').innerHTML = d.loading ? '<div class="spin">Loading…</div>' : vis.length ? vis.map((f, i) => {
    const slash = f.filename.lastIndexOf('/'); const dir = f.filename.slice(0, slash + 1), base = f.filename.slice(slash + 1);
    return `<div class="f ${f.filename === d.cur ? 'sel' : ''} ${f.viewed ? 'viewed' : ''}" data-f="${i}">
      <span class="chk" data-chk="${i}" title="Mark viewed">${f.viewed ? '✓' : ''}</span><span class="st st-${f.status}">${{ added: 'A', removed: 'D', renamed: 'R', modified: 'M' }[f.status] || 'M'}</span>
      <span class="name" title="${esc(f.filename)}"><bdi><span class="dir">${esc(dir)}</span>${esc(base)}${f.stale ? ' ↻' : ''}</bdi></span>
      <span class="nums"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span></div>`;
  }).join('') : '<div class="empty">No files match.</div>';
  $('#flist .sel')?.scrollIntoView({ block: 'nearest' });
  renderDiff();
}
let lastShown = null;
function renderDiff() { renderDiffInner(); refreshHighlights(); }
function renderDiffInner() {
  const f = curFile(); const head = $('#dhead'), box = $('#diff');
  if (!f) { head.innerHTML = ''; box.innerHTML = S.d.loading ? '' : '<div class="empty">Nothing to show</div>'; lastShown = null; return; }
  const idx = visibleFiles().indexOf(f);
  head.innerHTML = `<div class="path" title="${esc(f.filename)}">${f.previous_filename ? esc(f.previous_filename) + ' → ' : ''}${esc(f.filename)}</div>
    <span><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span><span style="color:var(--muted)">${idx + 1}/${visibleFiles().length}</span>
    <button id="eb" class="${f.expanded ? 'on' : ''}">${f.expanded ? 'Collapse' : 'Expand file'} <kbd>e</kbd></button>
    <button id="vb" class="${f.viewed ? 'on' : ''}">${f.viewed ? '✓ Viewed' : 'Mark viewed'} <kbd>v</kbd></button>`;
  const key = f.filename + '|' + !!f.expanded;
  if (lastShown === key) return; // only the header changes when toggling viewed
  const wasSame = lastShown && lastShown.split('|')[0] === f.filename; lastShown = key;
  box.style.scrollBehavior = 'auto'; box.scrollTop = 0;
  if (!f.patch) { box.innerHTML = `<div class="empty">${f.changes === 0 ? 'No content changes (rename / mode change).' : 'Diff not available (binary or too large). Press <kbd>O</kbd> to view on GitHub.'}</div>`; box.style.scrollBehavior = ''; return; }
  const lang = langFor(f.filename); const rows = []; let o = 0, n = 0; const lines = f.patch.split('\n'); const MAX = f.expanded ? 20000 : 4000;
  const full = f.expanded ? f.full : null; let next = 1; // next new-file line not yet emitted (expanded mode)
  const ctx = (upto, off) => { for (; next <= upto && next <= full.length; next++) rows.push(`<tr><td class="n">${next + off}</td><td class="n">${next}</td><td class="c"> ${hl(full[next - 1], lang)}</td></tr>`); };
  for (const l of lines.slice(0, MAX)) {
    if (l.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l); o = +m[1]; n = +m[2];
      if (full) ctx(n - 1, o - n); else rows.push(`<tr class="h"><td class="n"></td><td class="n"></td><td>${esc(l)}</td></tr>`);
    }
    else if (l.startsWith('+')) { rows.push(`<tr class="a"><td class="n"></td><td class="n">${n++}</td><td class="c">+${hl(l.slice(1), lang)}</td></tr>`); next = n; }
    else if (l.startsWith('-')) rows.push(`<tr class="d"><td class="n">${o++}</td><td class="n"></td><td class="c">-${hl(l.slice(1), lang)}</td></tr>`);
    else if (l.startsWith('\\')) rows.push(`<tr><td class="n"></td><td class="n"></td><td style="color:var(--muted)">${esc(l)}</td></tr>`);
    else { rows.push(`<tr><td class="n">${o++}</td><td class="n">${n++}</td><td class="c"> ${hl(l.slice(1), lang)}</td></tr>`); next = n; }
  }
  if (full) ctx(full.length, o - n);
  box.innerHTML = `<table>${rows.join('')}</table>${lines.length > MAX ? `<div class="empty">Diff truncated (${lines.length} lines). Press <kbd>O</kbd> to view on GitHub.</div>` : ''}`;
  if (f.expanded) box.querySelector('tr.a, tr.d')?.scrollIntoView({ block: 'center' });
  box.style.scrollBehavior = '';
}
async function toggleExpand() {
  const f = curFile(); if (!f) return;
  if (f.expanded) { f.expanded = false; return renderDiff(); }
  if (f.status === 'removed' || !f.patch) return toast(f.status === 'removed' ? 'File was deleted — nothing to expand' : 'No diff to expand');
  if (!f.full) {
    toast('Loading full file…');
    try {
      const path = f.filename.split('/').map(encodeURIComponent).join('/');
      const r = await fetch(`https://api.github.com/repos/${S.d.pr.repository.nameWithOwner}/contents/${path}?ref=${S.d.headOid}`, { headers: { Authorization: 'Bearer ' + S.token, Accept: 'application/vnd.github.raw+json' } });
      if (!r.ok) throw new Error('GitHub ' + r.status);
      const t = await r.text(); f.full = t.split('\n'); if (f.full[f.full.length - 1] === '') f.full.pop();
    } catch (e) { return toast('Could not load file: ' + e.message); }
  }
  if (curFile() !== f) return;
  f.expanded = true; renderDiff();
}

async function setViewed(f, v) {
  f.viewed = v; f.stale = false; updateFiles();
  try {
    await gql(`mutation($id:ID!,$p:String!){ ${v ? 'markFileAsViewed' : 'unmarkFileAsViewed'}(input:{pullRequestId:$id,path:$p}){ clientMutationId } }`, { id: S.d.prId, p: f.filename });
  } catch (e) { f.viewed = !v; updateFiles(); toast('Could not sync viewed state: ' + e.message); }
}
function undo() {
  const g = S.d.hist.pop(); if (!g) return toast('Nothing to undo');
  g.forEach(({ f, prev }) => setViewed(f, prev));
  const first = g[0].f; if (visibleFiles().includes(first)) S.d.cur = first.filename;
  updateFiles(); toast(`Undid ${g.length > 1 ? g.length + ' files' : 'last change'}`);
}
function toggleViewedAdvance(f) {
  S.d.hist.push([{ f, prev: f.viewed }]);
  const marking = !f.viewed; setViewed(f, marking);
  if (marking) gotoUnviewed(1, true);
}
function move(delta) {
  const vis = visibleFiles(); if (!vis.length) return;
  const i = Math.max(0, Math.min(vis.length - 1, vis.findIndex((f) => f.filename === S.d.cur) + delta));
  S.d.cur = vis[i].filename; updateFiles();
}
function gotoUnviewed(dir, quiet) {
  const vis = visibleFiles(); const start = vis.findIndex((f) => f.filename === S.d.cur);
  for (let k = 1; k <= vis.length; k++) {
    const f = vis[(start + dir * k + vis.length * k) % vis.length];
    if (!f.viewed && f !== vis[start]) { S.d.cur = f.filename; updateFiles(); return; }
  }
  if (!quiet || vis.every((f) => f.viewed)) toast(vis.length ? 'All shown files viewed ✓' : 'No files');
}


/* ---------- smart merge ---------- */
let merging = false;
async function smartMerge(pr) {
  if (!pr || merging) return;
  if (!confirm(`Smart merge ${pr.repository.nameWithOwner}#${pr.number}?\n\n${pr.title}\n\n1. Rebase-merge now if possible\n2. Else update branch + enable auto-merge (rebase)\n3. Else just update branch`)) return;
  merging = true;
  try {
    const [owner, name] = pr.repository.nameWithOwner.split('/');
    const Q = `query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){rebaseMergeAllowed autoMergeAllowed pullRequest(number:$num){id state isDraft mergeable mergeStateStatus headRefOid autoMergeRequest{enabledAt}}}}`;
    const fetchState = async () => (await gql(Q, { o: owner, n: name, num: pr.number })).repository;
    let repo = await fetchState(), p = repo.pullRequest;
    for (let i = 0; i < 5 && p.mergeable === 'UNKNOWN'; i++) { toast('Waiting for GitHub to compute mergeability…'); await new Promise((r) => setTimeout(r, 1500)); repo = await fetchState(); p = repo.pullRequest; }
    if (p.state !== 'OPEN') return toast('PR is not open');
    if (p.isDraft) return toast('PR is a draft — mark it ready first');
    if (p.mergeable === 'CONFLICTING') return toast('Merge conflicts — resolve them first');
    if (p.autoMergeRequest) return toast('Auto-merge is already enabled');

    // 1. rebase directly
    if (repo.rebaseMergeAllowed && ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(p.mergeStateStatus) && p.mergeable === 'MERGEABLE') {
      try {
        await gql(`mutation($id:ID!,$oid:GitObjectID!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:REBASE,expectedHeadOid:$oid}){clientMutationId}}`, { id: p.id, oid: p.headRefOid });
        toast('✓ Rebased and merged'); afterMerge(pr); return;
      } catch (e) { toast('Direct rebase failed (' + e.message + ') — trying next option'); await new Promise((r) => setTimeout(r, 1500)); }
    }
    // 2. update branch (if behind), then auto-merge
    let updated = false, note = '';
    if (p.mergeStateStatus === 'BEHIND') {
      try {
        await gql(`mutation($id:ID!,$oid:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$oid}){clientMutationId}}`, { id: p.id, oid: p.headRefOid });
        updated = true;
      } catch (e) { return toast('Could not update branch: ' + e.message); }
    }
    if (repo.autoMergeAllowed && repo.rebaseMergeAllowed) {
      try {
        await gql(`mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:REBASE}){clientMutationId}}`, { id: p.id });
        pr.autoMergeRequest = { enabledAt: new Date().toISOString() }; toast(`✓ ${updated ? 'Branch updated, a' : 'A'}uto-merge (rebase) enabled — it will merge when requirements pass`); afterMerge(pr, true); return;
      } catch (e) { note = ' Auto-merge failed: ' + e.message; }
    } else note = !repo.rebaseMergeAllowed ? ' Rebase merging is disabled for this repo.' : ' Auto-merge is not enabled for this repo.';
    // 3. tell the user
    toast((updated ? 'Branch updated.' : 'Nothing to merge automatically.') + note + ` Status: ${p.mergeStateStatus}. Needs manual attention.`);
  } catch (e) { toast('Merge failed: ' + e.message); }
  finally { merging = false; }
}
async function updateBranch(pr) {
  if (!pr || merging) return;
  merging = true;
  try {
    const [owner, name] = pr.repository.nameWithOwner.split('/');
    const p = (await gql(`query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){id headRefOid mergeStateStatus}}}`, { o: owner, n: name, num: pr.number })).repository.pullRequest;
    if (p.mergeStateStatus === 'DIRTY') return toast('Merge conflicts — cannot update automatically');
    if (p.mergeStateStatus !== 'BEHIND') return toast(`Branch is already up to date (${p.mergeStateStatus.toLowerCase()})`);
    await gql(`mutation($id:ID!,$oid:GitObjectID!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$oid}){clientMutationId}}`, { id: p.id, oid: p.headRefOid });
    pr.mergeStateStatus = 'UNKNOWN'; updateList(); toast(`✓ Updated branch of #${pr.number}`);
    setTimeout(() => S.view === 'list' && loadPRs(), 4000);
  } catch (e) { toast('Could not update branch: ' + e.message); }
  finally { merging = false; }
}
async function closePR(pr) {
  if (!pr || merging) return;
  if (!confirm(`Close (without merging) ${pr.repository.nameWithOwner}#${pr.number}?\n\n${pr.title}`)) return;
  merging = true;
  try {
    await gql(`mutation($id:ID!){closePullRequest(input:{pullRequestId:$id}){clientMutationId}}`, { id: pr.id });
    toast(`✓ Closed #${pr.number}`); afterMerge(pr);
  } catch (e) { toast('Could not close: ' + e.message); }
  finally { merging = false; }
}
function afterMerge(pr, autoOnly) {
  if (!autoOnly) S.prs = S.prs.filter((x) => x.id !== pr.id);
  if (S.view === 'pr' && !autoOnly) { back(); } else updateList();
  if (autoOnly) loadPRs();
}


/* ---------- command palette (Cmd/Ctrl+K): search PRs by title / description ---------- */
const P = { open: false, q: '', res: [], sel: 0 };
function openPalette() {
  P.open = true; P.q = ''; P.sel = 0;
  const el = $('#palette'); el.hidden = false;
  el.innerHTML = `<div class="box"><input id="pq" placeholder="Search PRs by title, description, repo, author, #number…" spellcheck="false"><div id="pres"></div><div class="phint"><kbd>↑</kbd><kbd>↓</kbd> select · <kbd>⏎</kbd> review · <kbd>⌘⏎</kbd> open on GitHub · <kbd>Esc</kbd> close — searching ${S.prs.length} loaded PRs</div></div>`;
  $('#pq').addEventListener('input', (e) => { P.q = e.target.value; P.sel = 0; updatePalette(); });
  el.onmousedown = (e) => { if (e.target === el) closePalette(); const r = e.target.closest('[data-pi]'); if (r) { e.preventDefault(); pickPalette(+r.dataset.pi); } };
  $('#pq').focus(); updatePalette();
}
function closePalette() { P.open = false; $('#palette').hidden = true; $('#palette').innerHTML = ''; }
function updatePalette() {
  const toks = P.q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const p of S.prs) {
    const title = `${p.title} #${p.number}`.toLowerCase(), other = `${p.repository.nameWithOwner} ${p.author?.login || ''}`.toLowerCase(), body = (p.bodyText || '').toLowerCase();
    if (!toks.every((t) => title.includes(t) || other.includes(t) || body.includes(t))) continue;
    const inTitle = toks.filter((t) => title.includes(t)).length;
    scored.push({ p, score: inTitle * 10 + toks.filter((t) => other.includes(t)).length * 3 });
  }
  scored.sort((a, b) => b.score - a.score || new Date(b.p.updatedAt) - new Date(a.p.updatedAt));
  P.res = scored.slice(0, 50).map((x) => x.p);
  P.sel = Math.min(P.sel, Math.max(0, P.res.length - 1));
  const mark = (txt) => { let h = esc(txt); toks.forEach((t) => { h = h.replace(new RegExp('(' + esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>'); }); return h; };
  const snippet = (p) => {
    const b = (p.bodyText || '').replace(/\s+/g, ' '); const low = b.toLowerCase();
    const hit = toks.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, c) => a - c)[0];
    if (hit == null || toks.every((t) => p.title.toLowerCase().includes(t))) return '';
    const a = Math.max(0, hit - 50); return (a ? '…' : '') + b.slice(a, a + 140) + '…';
  };
  $('#pres').innerHTML = P.res.length ? P.res.map((p, i) => `<div class="pi ${i === P.sel ? 'sel' : ''}" data-pi="${i}"><div><b>${mark(p.title)}</b></div>
    <div class="pm">${esc(p.repository.nameWithOwner)} #${p.number} · ${esc(p.author?.login || 'ghost')} · updated ${ago(p.updatedAt)} ago${p.isDraft ? ' · draft' : ''}</div>
    ${snippet(p) ? `<div class="ps">${mark(snippet(p))}</div>` : ''}</div>`).join('') : `<div class="empty" style="padding:24px">${S.prs.length ? 'No matches' : 'No PRs loaded yet'}</div>`;
  $('#pres .sel')?.scrollIntoView({ block: 'nearest' });
}
function pickPalette(i, external) {
  const p = P.res[i]; if (!p) return; closePalette();
  if (external) return ghOpen(p.url);
  const si = S.shown.findIndex((x) => x.id === p.id); if (si >= 0) S.sel = si;
  openPR(p);
}

/* ---------- help ---------- */
function toggleHelp(force) {
  const h = $('#help'); const show = force ?? h.hidden; h.hidden = !show;
  if (!show) return;
  const R = (k, d) => `<div class="r"><span>${d}</span><span>${k.map((x) => `<kbd>${x}</kbd>`).join(' ')}</span></div>`;
  h.innerHTML = `<div class="box"><h3>Keyboard shortcuts</h3>
   <div><h4>PR list</h4>${R(['j', '↓'], 'Next PR')}${R(['k', '↑'], 'Previous PR')}${R(['⏎', 'l'], 'Review files')}${R(['o'], 'Open on GitHub')}${R(['⇧M'], 'Smart merge')}${R(['⇧U'], 'Update branch (when behind)')}${R(['m'], 'Cycle merge filter: ready / needs update / auto / conflicts')}${R(['⇧X'], 'Close PR (no merge)')}${R(['/', '⌘F'], 'Focus filter')}${R(['⌘K / Ctrl+K'], 'Search PRs by title / description')}${R(['1', '–', '4'], 'Switch source')}${R(['s'], 'Cycle sort')}${R(['r'], 'Refresh')}${R(['d'], 'Toggle hide drafts')}${R(['x'], 'Clear filter')}</div>
   <div><h4>File review</h4>${R(['j', '↓'], 'Next file')}${R(['k', '↑'], 'Previous file')}${R(['n', 'p'], 'Next / prev unviewed')}${R(['Space', '⏎', 'v'], 'Toggle viewed (+ next unviewed)')}${R(['⇧J', '⇧K'], 'Scroll diff a bit')}${R(['Ctrl+D', 'Ctrl+U'], 'Half page down / up')}${R(['u'], 'Undo last viewed change')}${R(['e'], 'Expand / collapse whole file')}${R(['g', 'G'], 'Top / bottom of diff')}${R(['h'], 'Hide viewed files')}${R(['t'], 'Hide / show test files')}${R(['⇧V'], 'Mark all shown as viewed')}${R(['/'], 'Filter files')}${R(['⌘F / Ctrl+F'], 'Find in PR (Enter/⇧Enter next/prev, Tab scope)')}${R(['Ctrl+G'], 'Next find match')}${R(['[', ']'], 'Prev / next PR')}${R(['⇧M'], 'Smart merge')}${R(['⇧U'], 'Update branch (when behind)')}${R(['m'], 'Cycle merge filter: ready / needs update / auto / conflicts')}${R(['⇧X'], 'Close PR (no merge)')}${R(['o'], 'Open PR files on GitHub')}${R(['Esc', 'b'], 'Back to list')}</div>
   <div style="grid-column:1/-1;color:var(--muted);margin-top:8px">File filter: <code>*.ts</code> globs, <code>src/</code> folders, <code>!*.lock</code> excludes, space/comma separated. Viewed state syncs with GitHub.</div></div>`;
}

/* ---------- keyboard ---------- */
addEventListener('keydown', (e) => {
  const t = e.target;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (S.view === 'pr') { if (t.id === 'fq') t.select(); else openFind(); } else if (S.view === 'list') { $('#q').focus(); $('#q').select(); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault(); if (S.view !== 'login') (P.open ? closePalette() : openPalette()); return;
  }
  if (t.id === 'pq') {
    const mv = (d) => { P.sel = Math.max(0, Math.min(P.res.length - 1, P.sel + d)); updatePalette(); };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); mv(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); mv(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); pickPalette(P.sel, e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    return;
  }
  if (t.id === 'fq') {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    else if (e.key === 'Tab') { e.preventDefault(); toggleScope(); }
    return;
  }
  if (S.view === 'pr' && S.find?.open && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); return; }
  if (t.matches?.('input[type=text],input:not([type])')) {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === 'ArrowDown') { t.blur(); e.preventDefault(); }
    return;
  }
  if (e.ctrlKey && (e.key === 'd' || e.key === 'u') && $('#help').hidden) {
    e.preventDefault(); const dir = e.key === 'd' ? 1 : -1;
    if (S.view === 'pr') { const b = $('#diff'); b.scrollBy({ top: dir * b.clientHeight * 0.5, behavior: 'smooth' }); }
    else if (S.view === 'list') { S.sel = Math.max(0, Math.min(S.shown.length - 1, S.sel + dir * 8)); updateList(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('#help').hidden) { if (e.key === 'Escape' || e.key === '?') toggleHelp(false); e.preventDefault(); return; }
  if (e.key === '?') return toggleHelp(true);
  const k = e.key;
  if (S.view === 'list') {
    const sel = (i) => { S.sel = Math.max(0, Math.min(S.shown.length - 1, i)); updateList(); };
    if (k === 'j' || k === 'ArrowDown') sel(S.sel + 1);
    else if (k === 'k' || k === 'ArrowUp') sel(S.sel - 1);
    else if (k === 'g' || k === 'Home') sel(0);
    else if (k === 'G' || k === 'End') sel(1e9);
    else if (k === 'Enter' || k === 'l' || k === 'ArrowRight') openPR(S.shown[S.sel]);
    else if (k === 'o') S.shown[S.sel] && ghOpen(S.shown[S.sel].url);
    else if (k === 'M') smartMerge(S.shown[S.sel]);
    else if (k === 'X') closePR(S.shown[S.sel]);
    else if (k === 'U') updateBranch(S.shown[S.sel]);
    else if (k === 'm') { const order = ['', 'ready', 'behind', 'auto', 'conflict']; const cur = (S.q.match(/(?:^|\s)merge:(\w+)/) || [])[1] || ''; const nx = order[(order.indexOf(cur) + 1) % order.length]; setQuery(S.q.split(/\s+/).filter((t) => t && !t.startsWith('merge:')).concat(nx ? ['merge:' + nx] : []).join(' ')); toast(nx ? `Showing: ${MERGE_BADGE[nx][1]}` : 'Showing all merge states'); }
    else if (k === '/') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    else if (k >= '1' && k <= '4') setSource(SOURCES[+k - 1][0]);
    else if (k === 's') cycleSort();
    else if (k === 'r') loadPRs();
    else if (k === 'd') toggleToken('-is:draft');
    else if (k === 'x') setQuery('');
    else return;
    e.preventDefault();
  } else if (S.view === 'pr') {
    const f = curFile();
    if (k === 'j' || k === 'ArrowDown') move(1);
    else if (k === 'k' || k === 'ArrowUp') move(-1);
    else if (k === 'v' || k === 'x' || k === ' ' || k === 'Enter') f && toggleViewedAdvance(f);
    else if (k === 'V') { const g = visibleFiles().filter((x) => !x.viewed); if (g.length) S.d.hist.push(g.map((f) => ({ f, prev: false }))); g.forEach((x) => setViewed(x, true)); }
    else if (k === 'n') gotoUnviewed(1);
    else if (k === 'p') gotoUnviewed(-1);
    else if (k === 't') { S.hideTests = !S.hideTests; lset('hideTests', S.hideTests); $('#ht').checked = S.hideTests; updateFiles(); toast(S.hideTests ? 'Hiding test files' : 'Showing test files'); }
    else if (k === 'h') { S.d.hideViewed = !S.d.hideViewed; $('#hv').checked = S.d.hideViewed; updateFiles(); }
    else if (k === 'J' || k === 'K') $('#diff').scrollBy({ top: k === 'J' ? 160 : -160, behavior: 'smooth' });
    else if (k === 'u') undo();
    else if (k === 'e') toggleExpand();
    else if (k === 'g') $('#diff').scrollTo({ top: 0, behavior: 'smooth' });
    else if (k === 'G') $('#diff').scrollTo({ top: 1e9, behavior: 'smooth' });
    else if (k === '/') { $('#ff').focus(); $('#ff').select(); }
    else if (k === '[') otherPR(-1);
    else if (k === ']') otherPR(1);
    else if (k === 'M') smartMerge(S.d.pr);
    else if (k === 'X') closePR(S.d.pr);
    else if (k === 'o' || k === 'O') ghOpen(S.d.pr.url + '/files');
    else if (k === 'Escape' && S.find?.open) closeFind();
    else if (k === 'Escape' || k === 'b' || k === 'ArrowLeft') back();
    else return;
    e.preventDefault();
  }
});

/* ---------- login / boot ---------- */
function render() {
  if (S.view === 'login') {
    $('#app').innerHTML = `<div class="top"><b>LGTM</b></div><div style="display:grid;flex:1"><div class="login">
      <h2 style="margin:0">Connect to GitHub</h2>
      <div style="color:var(--muted)">Paste a personal access token (classic with <code>repo</code> scope, or fine-grained with Pull requests: read/write and Contents: read). Or run <code>gh auth login</code> and restart — the app picks it up automatically. The token is stored encrypted on this machine.</div>
      <input id="tok" type="password" placeholder="ghp_… / github_pat_…"><button id="go" class="on">Connect</button><div id="err" class="del"></div></div></div>`;
    const go = async () => {
      const token = $('#tok').value.trim(); if (!token) return;
      S.token = token;
      try { await gql('{viewer{login}}'); await native.setToken(token); start(); } catch (e) { $('#err').textContent = e.message; S.token = null; }
    };
    $('#go').onclick = go; $('#tok').onkeydown = (e) => e.key === 'Enter' && go();
    $('#tok').focus();
  }
}
function start() { S.view = 'list'; mountList(); updateList(); loadPRs(); }
$('#app').addEventListener('click', (e) => { listClick(e); prClick(e); if (e.target.closest('button')) e.target.closest('button').blur(); });
(async () => {
  if (await native.isDemo()) { S.token = 'demo'; return start(); }
  const { token } = await native.getToken();
  if (token) { S.token = token; start(); } else render();
})();
