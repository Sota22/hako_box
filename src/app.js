(function () {
'use strict';
const E = window.QS;
const { BK, POPCNT } = E;
const KANJI = ['玉', '飛', '角', '金', '銀', '桂', '香', '歩'];
const PROMK = ['', '龍', '馬', '', '全', '圭', '杏', 'と'];
const RANK = '一二三四五六七八九';
const FILE = '９８７６５４３２１';
const MARK = ['▲', '△'];
const SIDE_NAME = ['先手', '後手'];
const LEVELS = [
  { ms: 1000, name: 'はやい', note: '約1秒' },
  { ms: 3000, name: 'つよい', note: '約3秒' },
  { ms: 7000, name: 'とてもつよい', note: '約7秒' },
  { ms: 15000, name: '全力', note: '約15秒' },
];
const SAVE_KEY = 'quantum-shogi-v1';

const $ = (s, el) => (el || document).querySelector(s);
const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

// ---- 対局状態 ----
const G = {
  mode: 'ai',      // 'ai' | 'pvp'
  human: 0,        // AI対戦で人間が持つ手番
  level: 2,
  pos: new E.Pos(),
  snaps: [],       // 各局面 {state, h1, h2, label, move:{from,to}}
  over: null,      // {winner, reason}
  sel: null,       // {id, targets: Map(to -> [moves])}
  legal: [],
  thinking: false,
  info: null,      // AIの読み
  flip: false,
  collapsed: new Set(),
  hint: null,      // {move, score, depth} おすすめの一手
  hinting: false,  // ヒントを考え中
};

function sqName(sq) { return FILE[sq % 9] + RANK[(sq / 9) | 0]; }
function maskChars(m, prom) {
  const out = [];
  for (let t = 0; t < 8; t++) if (m >> t & 1) out.push(prom && PROMK[t] ? PROMK[t] : KANJI[t]);
  return out;
}

function newGame(mode, human, level) {
  G.mode = mode; G.human = human; G.level = level;
  G.pos = new E.Pos();
  G.pos.normalize();
  G.snaps = [{ state: G.pos.serialize(), h1: G.pos.h1, h2: G.pos.h2, label: null, move: null }];
  G.over = null; G.sel = null; G.info = null; G.collapsed = new Set();
  G.flip = mode === 'ai' && human === 1;
  cancelThink();
  afterPosition();
}

function restorePos() {
  const s = G.snaps[G.snaps.length - 1];
  G.pos.load(s.state);
}

function isHumanTurn() {
  return !G.over && (G.mode === 'pvp' || G.pos.side === G.human);
}

function afterPosition() {
  G.sel = null;
  G.hint = null;
  G.legal = G.over ? [] : G.pos.legalMoves();
  if (!G.over && G.legal.length === 0) {
    G.over = { winner: G.pos.side ^ 1, reason: '指せる手がなくなりました' };
  }
  save();
  render();
  if (!G.over && G.mode === 'ai' && G.pos.side !== G.human) startThink();
}

// 1手指す
function play(m) {
  const p = G.pos, d = E.decode(m);
  const before = Array.from(p.mask);
  const from = p.pos[d.id], mover = p.side, cap = p.board[d.to];
  const capMask = cap >= 0 ? p.mask[cap] : 0;
  const win = p.make(m);
  let label = MARK[mover] + sqName(d.to) + (from < 0 ? '打' : '') + (d.prom ? '成' : '');
  const chars = maskChars(d.mask, p.prom[d.id]).join('');
  if (!win) p.normalize();
  else { p.usp = 0; p.hsp = 0; p.rehash(); }
  G.collapsed = new Set();
  for (let id = 0; id < 40; id++) if (p.mask[id] !== before[id]) G.collapsed.add(id);
  G.snaps.push({ state: p.serialize(), h1: p.h1, h2: p.h2, label, chars, capChars: cap >= 0 ? maskChars(capMask, 0).join('') : '', move: { from, to: d.to } });
  if (win) {
    G.over = { winner: mover, reason: '玉でしかありえない駒を取りました' };
  } else {
    let rep = 0;
    for (const s of G.snaps) if (s.h1 === p.h1 && s.h2 === p.h2) rep++;
    if (rep >= 4) G.over = { winner: -1, reason: '同じ局面が4回現れました（千日手）' };
    else if (G.snaps.length > 600) G.over = { winner: -1, reason: '手数が上限に達しました' };
  }
  afterPosition();
}

function undo() {
  if (G.snaps.length <= 1) return;
  cancelThink();
  if (G.mode === 'pvp') G.snaps.length -= 1;
  else {
    // 自分の手番まで戻す
    do { G.snaps.length -= 1; } while (G.snaps.length > 1 && G.snaps[G.snaps.length - 1].state.side !== G.human);
  }
  G.over = null; G.info = null; G.collapsed = new Set();
  restorePos();
  afterPosition();
}

// ---- AI ----
let worker = null, workerFailed = false, thinkId = 0;
function makeWorker() {
  if (worker || workerFailed) return worker;
  try {
    const src = $('#qs-engine').textContent + '\n' + WORKER_GLUE;
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    worker = new Worker(url);
    worker.onmessage = onWorkerMessage;
    worker.onerror = () => {
      worker = null; workerFailed = true;
      if (G.thinking) { G.thinking = false; startThink(); }
      else if (G.hinting) { G.hinting = false; startThink('hint'); }
    };
  } catch (e) {
    workerFailed = true; worker = null;
  }
  return worker;
}
const WORKER_GLUE = `
let P = null, S = null;
self.onmessage = function (e) {
  const d = e.data;
  if (!P) { P = new QS.Pos(); S = new QS.Searcher(P, 20); }
  P.load(d.state);
  for (const x of d.hist) P.pushHistory(x[0], x[1]);
  S.setPos(P);
  const r = S.think(d.time, 40, function (i) { self.postMessage({ type: 'info', id: d.id, kind: d.kind, info: { depth: i.depth, score: i.score, nodes: i.nodes } }); });
  self.postMessage({ type: 'done', id: d.id, kind: d.kind, move: r.move, score: r.score, depth: r.depth, nodes: r.nodes });
};`;

let mainSearcher = null;
function startThink(kind) {
  if (G.thinking || G.hinting || G.over) return;
  kind = kind || 'ai';
  if (kind === 'hint') { G.hinting = true; G.hint = null; } else { G.thinking = true; G.info = null; }
  const id = ++thinkId;
  const msg = {
    id, kind, state: G.pos.serialize(),
    time: kind === 'hint' ? Math.min(Math.max(LEVELS[G.level].ms, 2500), 5000) : LEVELS[G.level].ms, // ヒントは2.5〜5秒
    hist: G.snaps.map(s => [s.h1, s.h2]),
  };
  render();
  const w = makeWorker();
  if (w) { w.postMessage(msg); return; }
  // Worker が使えない環境ではメインスレッドで考える
  setTimeout(() => {
    if (id !== thinkId) return;
    const p = new E.Pos(); p.load(msg.state);
    for (const x of msg.hist) p.pushHistory(x[0], x[1]);
    if (!mainSearcher) mainSearcher = new E.Searcher(p, 18); else mainSearcher.setPos(p);
    const r = mainSearcher.think(Math.min(msg.time, 4000), 40);
    onWorkerMessage({ data: { type: 'done', id, kind, move: r.move, score: r.score, depth: r.depth } });
  }, 60);
}
function onWorkerMessage(e) {
  const d = e.data;
  if (d.id !== thinkId) return;
  if (d.type === 'info') {
    if (d.kind !== 'hint' && G.thinking) G.info = d.info;
    if (G.hinting) G.hintDepth = d.info.depth;
    renderStatus();
    return;
  }
  if (d.kind === 'hint') {
    G.hinting = false;
    if (d.move && G.legal.includes(d.move)) G.hint = { move: d.move, score: d.score, depth: d.depth };
    render();
    return;
  }
  G.thinking = false;
  G.info = { depth: d.depth, score: d.score };
  if (!d.move || G.over) { render(); return; }
  play(d.move);
}
function cancelThink() {
  thinkId++;
  if ((G.thinking || G.hinting) && worker) { worker.terminate(); worker = null; }
  G.thinking = false;
  G.hinting = false;
}

function requestHint() {
  if (!isHumanTurn() || G.thinking || G.hinting) return;
  if (G.hint) { G.hint = null; render(); return; } // もう一度押すと消す
  G.sel = null;
  G.hintDepth = 0;
  startThink('hint');
}

// 手の説明（ヒント用）
function describeMove(m) {
  const p = G.pos, d = E.decode(m), from = p.pos[d.id];
  const prom = d.prom || p.prom[d.id];
  const where = from < 0
    ? `持ち駒を${sqName(d.to)}に打つ`
    : `${sqName(from)}の駒を${sqName(d.to)}へ${d.prom ? '（成る）' : ''}`;
  const cap = p.board[d.to] >= 0 ? '　相手の駒を取る' : '';
  return { where: where + cap, chars: maskChars(d.mask, prom).join(' '), mark: MARK[p.side] + sqName(d.to) + (from < 0 ? '打' : '') + (d.prom ? '成' : '') };
}

// ---- 保存 ----
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ mode: G.mode, human: G.human, level: G.level, flip: G.flip, snaps: G.snaps, over: G.over }));
  } catch (e) { /* 保存できない環境でも遊べる */ }
}
function loadSaved(data) {
  try {
    const o = data || JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!o || !o.snaps || !o.snaps.length) return false;
    G.mode = o.mode; G.human = o.human; G.level = o.level ?? 2; G.flip = !!o.flip;
    G.snaps = o.snaps; G.over = o.over || null;
    restorePos();
    return true;
  } catch (e) { return false; }
}

// ---- 描画 ----
function pieceEl(id, opts) {
  const p = G.pos, m = p.mask[id], pr = p.prom[id];
  const el = h('div', 'piece');
  const bottom = G.flip ? 1 : 0;
  if (p.owner[id] !== bottom && !(opts && opts.upright)) el.classList.add('gote');
  if (pr) el.classList.add('prom');
  if (G.collapsed.has(id)) el.classList.add('collapsed');
  // 相手から取った駒（元の陣営と今の持ち主が違う）には印を付ける
  if ((id < 20 ? 0 : 1) !== p.owner[id]) { el.classList.add('turned'); el.appendChild(h('i', 'turned-mark')); }
  const n = POPCNT[m];
  if (n === 1) {
    const t = 31 - Math.clz32(m);
    let c = pr && PROMK[t] ? PROMK[t] : KANJI[t];
    if (t === 0 && p.owner[id] === 1) c = '王';
    el.appendChild(h('span', 'one', c));
  } else {
    const g = h('div', 'glyphs ' + (n <= 4 ? 'c2' : 'c3'));
    for (let t = 0; t < 8; t++) {
      if (!(m >> t & 1)) continue;
      const s = h('span', t === 0 ? 'k' : '', pr && PROMK[t] ? PROMK[t] : KANJI[t]);
      g.appendChild(s);
    }
    el.appendChild(g);
  }
  return el;
}

function dangerSquares() {
  const p = G.pos, out = new Set();
  p.prune();
  for (let s = 0; s < 2; s++) {
    const k = p.kingOnly(s);
    if (k >= 0 && p.attackedBy(p.pos[k], s ^ 1)) out.add(p.pos[k]);
  }
  return out;
}

function render() {
  const p = G.pos;
  const board = $('#board');
  board.textContent = '';
  const last = G.snaps[G.snaps.length - 1].move;
  const danger = dangerSquares();
  const sel = G.sel;
  let hint = null;
  if (G.hint) { const d = E.decode(G.hint.move); hint = { from: p.pos[d.id], to: d.to }; }
  for (let i = 0; i < 81; i++) {
    const sq = G.flip ? 80 - i : i;
    const c = h('button', 'cell');
    c.type = 'button';
    c.dataset.sq = sq;
    c.setAttribute('aria-label', sqName(sq));
    if (last && (last.to === sq || last.from === sq)) c.classList.add('last');
    const id = p.board[sq];
    if (id >= 0) {
      c.appendChild(pieceEl(id));
      if (danger.has(sq)) c.classList.add('danger');
      if (sel && sel.id === id) c.classList.add('sel');
    }
    if (sel && sel.targets.has(sq)) { c.classList.add('dest'); if (id >= 0) c.classList.add('cap'); }
    if (hint) {
      if (hint.to === sq) c.classList.add('hint-to');
      if (hint.from === sq) c.classList.add('hint-from');
    }
    board.appendChild(c);
  }
  $('#files').textContent = '';
  for (let i = 0; i < 9; i++) $('#files').appendChild(h('span', '', String(G.flip ? i + 1 : 9 - i)));
  $('#ranks').textContent = '';
  for (let i = 0; i < 9; i++) $('#ranks').appendChild(h('span', '', RANK[G.flip ? 8 - i : i]));
  renderHand($('#hand-top'), G.flip ? 0 : 1);
  renderHand($('#hand-bottom'), G.flip ? 1 : 0);
  renderStatus();
  renderInfo();
  renderLog();
  $('#undo').disabled = G.snaps.length <= 1;
  const hb = $('#hint');
  hb.disabled = !isHumanTurn() || G.thinking || G.hinting;
  hb.textContent = G.hinting ? '考え中…' : G.hint ? 'ヒントを消す' : 'ヒント';
  hb.classList.toggle('on', !!G.hint);
  if (G.over && !G.shownOver) { G.shownOver = true; showResult(); }
  if (!G.over) G.shownOver = false;
}

function renderHand(el, side) {
  const p = G.pos;
  el.textContent = '';
  const who = h('span', 'who', playerName(side));
  el.appendChild(who);
  const groups = new Map();
  for (let id = 0; id < 40; id++) {
    if (p.owner[id] !== side || p.pos[id] >= 0) continue;
    const k = p.mask[id] | (id < 20 ? 0 : 256);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  }
  if (!groups.size) { el.appendChild(h('span', 'empty', '持ち駒なし')); return; }
  const keys = [...groups.keys()].sort((a, b) => (POPCNT[a & 255] - POPCNT[b & 255]) || ((b & 255) - (a & 255)) || (a - b));
  for (const k of keys) {
    const ids = groups.get(k), m = k & 255;
    const b = h('button', 'hand-piece');
    b.type = 'button';
    b.dataset.id = ids[0];
    b.setAttribute('aria-label', '持ち駒 ' + maskChars(m, 0).join('・'));
    b.appendChild(pieceEl(ids[0], { upright: true }));
    if (ids.length > 1) b.appendChild(h('span', 'cnt', String(ids.length)));
    if (G.sel && ids.includes(G.sel.id)) b.classList.add('sel');
    if (G.hint && ids.includes(G.hint.move & 63)) b.classList.add('hint-from');
    el.appendChild(b);
  }
}

function playerName(side) {
  if (G.mode === 'pvp') return SIDE_NAME[side];
  return side === G.human ? 'あなた' : 'AI';
}

function renderStatus() {
  const p = G.pos;
  const pill = $('#turn');
  const msg = $('#msg');
  msg.classList.remove('alert');
  if (G.over) {
    pill.textContent = '終局';
    pill.className = 'turn-pill';
    msg.textContent = G.over.reason;
  } else {
    pill.textContent = MARK[p.side] + SIDE_NAME[p.side] + (G.mode === 'ai' ? (p.side === G.human ? '（あなた）' : '（AI）') : '');
    pill.className = 'turn-pill' + (isHumanTurn() ? ' mine' : '');
    const d = dangerSquares();
    const k = p.kingOnly(p.side);
    if (k >= 0 && d.has(p.pos[k])) { msg.textContent = '玉が確定していて、取られそうです'; msg.classList.add('alert'); }
    else if (G.hinting) msg.textContent = 'おすすめの手を探しています…' + (G.hintDepth ? `（${G.hintDepth}手先まで）` : '');
    else if (G.thinking) msg.textContent = 'AI が読んでいます…' + (G.info ? `（${G.info.depth}手先まで）` : '');
    else if (G.sel) msg.textContent = '動かす先を選んでください';
    else msg.textContent = isHumanTurn() ? '駒を選んでください' : '';
  }
  // 形勢メーター（あなた／先手から見た評価）
  const meter = $('#meter > i');
  let pct = 50;
  if (G.info && G.info.score != null && G.mode === 'ai') {
    // AI 視点の評価を人間視点へ
    let sc = -G.info.score;
    if (Math.abs(sc) > 900000) sc = sc > 0 ? 3000 : -3000;
    pct = 50 + 50 * Math.tanh(sc / 1500);
  }
  meter.style.width = pct.toFixed(1) + '%';
  $('#meter').hidden = G.mode !== 'ai';
  $('#meter').title = 'あなたから見た形勢（AIの読み）';
}

function renderInfo() {
  const box = $('#info');
  box.textContent = '';
  const p = G.pos;
  const row = h('div', 'row');
  if (G.hint && !G.sel) {
    const d = describeMove(G.hint.move);
    const r1 = h('div', 'row hint-row');
    r1.appendChild(h('span', 'hint-tag', 'おすすめ'));
    r1.appendChild(h('span', 'hint-move', d.mark));
    r1.appendChild(h('span', 'label', d.where));
    box.appendChild(r1);
    const r2 = h('div', 'row');
    r2.appendChild(h('span', 'label', '指した後の正体の候補'));
    for (const c of d.chars.split(' ')) r2.appendChild(h('span', 'chip', c));
    box.appendChild(r2);
    const r3 = h('div', 'row');
    const sc = G.hint.score;
    let verdict;
    if (sc > 900000) verdict = 'この手で勝ちが見えています';
    else if (sc < -900000) verdict = '苦しい局面です。いちばん粘れる手を選びました';
    else verdict = `${G.hint.depth}手先まで読んだ結果です`;
    r3.appendChild(h('span', 'label', verdict));
    const go = h('button', 'btn primary small', 'この手を指す');
    go.type = 'button';
    go.onclick = () => { if (G.hint && isHumanTurn()) play(G.hint.move); };
    r3.appendChild(go);
    box.appendChild(r3);
    return;
  }
  if (G.sel) {
    const id = G.sel.id;
    row.appendChild(h('span', 'label', p.pos[id] < 0 ? '持ち駒の正体の候補' : 'この駒の正体の候補'));
    for (let t = 0; t < 8; t++) {
      const on = p.mask[id] >> t & 1;
      if (t === 0 && p.pos[id] < 0) continue;
      const c = h('span', 'chip' + (on ? '' : ' off') + (t === 0 ? ' k' : ''), p.prom[id] && PROMK[t] ? PROMK[t] : KANJI[t]);
      row.appendChild(c);
    }
    box.appendChild(row);
    const army = id < 20 ? 0 : 1;
    if (army !== p.owner[id]) {
      const r2 = h('div', 'row');
      r2.appendChild(h('i', 'turned-mark inline'));
      r2.appendChild(h('span', 'label', `${playerName(army)}から取った駒。${playerName(army)}の陣営の駒として正体が絞られます`));
      box.appendChild(r2);
    }
  } else {
    // 玉の候補の数
    p.prune();
    for (let s = 0; s < 2; s++) {
      let n = 0;
      for (let id = s * 20; id < s * 20 + 20; id++) if (p.pos[id] >= 0 && (p.mask[id] & BK)) n++;
      const r = h('div', 'row');
      r.appendChild(h('span', 'label', playerName(s) + 'の玉の候補'));
      r.appendChild(h('span', 'chip k', n === 1 ? '確定' : n + '枚'));
      box.appendChild(r);
    }
  }
}

function renderLog() {
  const ol = $('#log-list');
  ol.textContent = '';
  for (let i = 1; i < G.snaps.length; i++) {
    const s = G.snaps[i];
    const li = h('li');
    li.appendChild(h('span', 'm', s.label));
    li.appendChild(h('span', 'q', ' → ' + s.chars + (s.capChars ? '　取：' + s.capChars : '')));
    ol.appendChild(li);
  }
  $('#log-count').textContent = String(G.snaps.length - 1);
  ol.scrollTop = ol.scrollHeight;
}

// ---- 操作 ----
function selectPiece(id) {
  const targets = new Map();
  for (const m of G.legal) {
    if ((m & 63) !== id) continue;
    const to = (m >> 6) & 127;
    if (!targets.has(to)) targets.set(to, []);
    targets.get(to).push(m);
  }
  G.sel = { id, targets };
  render();
}

function onBoardTap(sq) {
  if (!isHumanTurn() || G.thinking) return;
  const p = G.pos;
  if (G.sel && G.sel.targets.has(sq)) { chooseMove(G.sel.targets.get(sq)); return; }
  const id = p.board[sq];
  if (id >= 0 && p.owner[id] === p.side) {
    if (G.sel && G.sel.id === id) { G.sel = null; render(); return; }
    selectPiece(id);
    return;
  }
  if (G.sel) { G.sel = null; render(); }
}

function onHandTap(id) {
  if (!isHumanTurn() || G.thinking) return;
  if (G.pos.owner[id] !== G.pos.side) return;
  if (G.sel && G.sel.id === id) { G.sel = null; render(); return; }
  selectPiece(id);
}

function chooseMove(moves) {
  if (moves.length === 1) { play(moves[0]); return; }
  const p = G.pos;
  const sheet = openSheet();
  sheet.appendChild(h('h2', '', '成りますか？'));
  sheet.appendChild(h('p', '', '成ると、成れない駒（玉・金）の可能性が消えます。'));
  const box = h('div', 'prom-choice');
  for (const m of [...moves].sort((a, b) => ((b >> 13) & 1) - ((a >> 13) & 1))) {
    const d = E.decode(m);
    const b = h('button', 'opt');
    b.type = 'button';
    b.appendChild(h('b', '', d.prom ? '成る' : '成らない'));
    b.appendChild(h('span', 'chars' + (d.prom ? ' p' : ''), maskChars(d.mask, d.prom || p.prom[d.id]).join(' ')));
    b.onclick = () => { closeSheet(); play(m); };
    box.appendChild(b);
  }
  sheet.appendChild(box);
  const cancel = h('button', 'btn', 'やめる');
  cancel.type = 'button';
  cancel.onclick = closeSheet;
  const act = h('div', 'actions'); act.appendChild(cancel); sheet.appendChild(act);
}

// ---- ダイアログ ----
function openSheet() {
  closeSheet();
  const bg = h('div', 'sheet-bg');
  bg.id = 'sheet-bg';
  const sh = h('div', 'sheet');
  sh.setAttribute('role', 'dialog');
  bg.appendChild(sh);
  bg.addEventListener('click', e => { if (e.target === bg) closeSheet(); });
  document.body.appendChild(bg);
  return sh;
}
function closeSheet() { const b = $('#sheet-bg'); if (b) b.remove(); }

function showNewGame() {
  const sh = openSheet();
  sh.appendChild(h('h2', '', '新しい対局'));
  let mode = G.mode, human = G.human, level = G.level;
  const modes = [
    { k: 'ai0', label: 'AIと対戦（先手）', note: 'あなたが先に指す' },
    { k: 'ai1', label: 'AIと対戦（後手）', note: 'AIが先に指す' },
    { k: 'pvp', label: '2人で対戦', note: '1台のスマホで交互に' },
  ];
  let cur = mode === 'pvp' ? 'pvp' : 'ai' + human;
  sh.appendChild(h('h3', '', '対戦相手'));
  const mo = h('div', 'opts');
  const lv = h('div', 'opts');
  const lvTitle = h('h3', '', 'AIの強さ（考える時間）');
  const draw = () => {
    mo.textContent = ''; lv.textContent = '';
    for (const m of modes) {
      const b = h('button', 'opt' + (cur === m.k ? ' on' : ''));
      b.type = 'button';
      b.appendChild(h('b', '', m.label)); b.appendChild(h('small', '', m.note));
      b.onclick = () => { cur = m.k; draw(); };
      mo.appendChild(b);
    }
    LEVELS.forEach((L, i) => {
      const b = h('button', 'opt' + (level === i ? ' on' : ''));
      b.type = 'button';
      b.appendChild(h('b', '', L.name)); b.appendChild(h('small', '', L.note));
      b.onclick = () => { level = i; draw(); };
      lv.appendChild(b);
    });
    lvTitle.hidden = lv.hidden = cur === 'pvp';
  };
  draw();
  sh.appendChild(mo); sh.appendChild(lvTitle); sh.appendChild(lv);
  const act = h('div', 'actions');
  const c = h('button', 'btn', 'キャンセル'); c.type = 'button'; c.onclick = closeSheet;
  const ok = h('button', 'btn primary', '対局開始'); ok.type = 'button';
  ok.onclick = () => {
    closeSheet();
    if (cur === 'pvp') newGame('pvp', 0, level); else newGame('ai', cur === 'ai1' ? 1 : 0, level);
  };
  act.appendChild(c); act.appendChild(ok); sh.appendChild(act);
}

function showRules() {
  const sh = openSheet();
  sh.innerHTML = `
    <h2>量子将棋のルール</h2>
    <p>すべての駒が「玉・飛・角・金・銀・桂・香・歩のどれなのか分からない」状態から始まります。駒に書かれた小さな字は、その駒の正体の候補です。</p>
    <h3>観測：動かすと正体が絞られる</h3>
    <ul>
      <li>駒は、候補のどれかとして動けるなら、その動きで指せます。</li>
      <li>指した後、その動きができない種類は候補から消えます。たとえば2マス前に進むと「飛・香」に絞られます。</li>
      <li>それぞれの陣営の駒は合わせて「玉1・飛1・角1・金2・銀2・桂2・香2・歩9」です。これと矛盾する候補は自動で消えます。ほかの駒が確定すると、残りの駒の候補も減ります。</li>
    </ul>
    <h3>取る・打つ・成る</h3>
    <ul>
      <li>取った駒は持ち駒になり、候補を残したまま打てます（玉にはなりません）。</li>
      <li>駒は元の陣営を覚えています。取った駒には <i class="turned-mark inline"></i> の印が付き、動かすと元の陣営（相手側）の駒の候補だけが絞られます。</li>
      <li>敵陣に入る・出る・敵陣で動くときは成れます。成ると、成れない「玉・金」の候補が消えます。</li>
      <li>正体は動かしたときだけ絞られます。打った場所や行った場所を理由に候補が消えることはありません。</li>
      <li>動けなくなる場所（1段目の歩・香、1〜2段目の桂）にも、ほかの候補があれば打ったり成らずに行ったりできます。後で歩などと確定したら、その駒はそこから動けません。候補が全部そういう駒なら、そこへは成らないと行けません。</li>
      <li>二歩は、歩と確定した駒を、歩と確定した駒がある筋に打つときだけ禁止です。</li>
    </ul>
    <h3>勝ち負け</h3>
    <ul>
      <li>王手の概念はありません。相手の「玉でしかありえない駒」を取ったら勝ちです。</li>
      <li>玉の候補が1枚になると、その駒は玉で確定します。確定した玉が狙われていると赤く表示されます。</li>
      <li>指せる手がなくなったら負け、同じ局面が4回で引き分けです。</li>
    </ul>
    <h3>コツ</h3>
    <ul>
      <li>玉の候補をたくさん残すほど、相手は玉を狙いにくくなります。</li>
      <li>重ね合わせの駒はどの動きもできる強い駒です。正体を早く明かしすぎないように。</li>
    </ul>`;
  const act = h('div', 'actions');
  const c = h('button', 'btn primary', '閉じる'); c.type = 'button'; c.onclick = closeSheet;
  act.appendChild(c); sh.appendChild(act);
}

function showResult() {
  const sh = openSheet();
  const o = G.over;
  let text, cls = 'result';
  if (o.winner < 0) text = '引き分け';
  else if (G.mode === 'ai') { const w = o.winner === G.human; text = w ? 'あなたの勝ち' : 'AIの勝ち'; cls += w ? ' win' : ' lose'; }
  else text = SIDE_NAME[o.winner] + 'の勝ち';
  sh.appendChild(h('div', cls, text));
  sh.appendChild(h('p', '', o.reason + `（${G.snaps.length - 1}手）`));
  const act = h('div', 'actions');
  const u = h('button', 'btn', '待った'); u.type = 'button'; u.onclick = () => { closeSheet(); undo(); };
  const c = h('button', 'btn', '盤を見る'); c.type = 'button'; c.onclick = closeSheet;
  const n = h('button', 'btn primary', 'もう一局'); n.type = 'button'; n.onclick = () => { closeSheet(); showNewGame(); };
  act.appendChild(u); act.appendChild(c); act.appendChild(n); sh.appendChild(act);
}

// ---- 起動 ----
function layout() {
  const w = $('#board').getBoundingClientRect().width;
  if (w > 0) document.documentElement.style.setProperty('--cell', (w / 9).toFixed(2) + 'px');
}

function start(data) {
  $('#board').addEventListener('click', e => {
    const c = e.target.closest('.cell');
    if (c) onBoardTap(+c.dataset.sq);
  });
  for (const id of ['#hand-top', '#hand-bottom']) {
    $(id).addEventListener('click', e => {
      const b = e.target.closest('.hand-piece');
      if (b) onHandTap(+b.dataset.id);
    });
  }
  $('#new').onclick = showNewGame;
  $('#rules').onclick = showRules;
  $('#undo').onclick = undo;
  $('#hint').onclick = requestHint;
  $('#flip').onclick = () => { G.flip = !G.flip; render(); };
  window.addEventListener('resize', layout);
  if (loadSaved(data && data.game)) {
    afterPosition();
  } else {
    newGame('ai', 0, 2);
  }
  layout();
  if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
    window.claude.hot.snapshot(() => ({ game: { mode: G.mode, human: G.human, level: G.level, flip: G.flip, snaps: G.snaps, over: G.over } }));
  }
}

const hot = window.claude && window.claude.hot;
if (hot && hot.ready) hot.ready(start); else start((hot && hot.data) || {});
})();
