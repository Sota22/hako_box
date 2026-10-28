(function () {
'use strict';
const E = window.SG;
const { SHOGI, GO, STONE, K, PROM, END_TURN } = E;
const KANJI = { 1: '玉', 2: '飛', 3: '角', 4: '金', 5: '銀', 6: '桂', 7: '香', 8: '歩', 10: '龍', 11: '馬', 13: '全', 14: '圭', 15: '杏', 16: 'と' };
const RANK = '一二三四五六七八九';
const FILE = '９８７６５４３２１';
const MARK = ['▲', '●'];
const SIDE_NAME = ['将棋', '囲碁'];
const LEVELS = [
  { ms: 1000, name: 'はやい', note: '約1秒' },
  { ms: 3000, name: 'つよい', note: '約3秒' },
  { ms: 7000, name: 'とてもつよい', note: '約7秒' },
  { ms: 15000, name: '全力', note: '約15秒' },
];
// 手合い。互角は AI 同士の対局で将棋側と囲碁側の勝率がほぼ半々になる設定
const HANDI = [
  { k: 'even', label: '互角', note: '標準', rules: {} },
  { k: 'lance', label: '香落ち', note: '囲碁側を少し助ける', rules: { handicap: 'lance' } },
  { k: 'bishop', label: '角落ち', note: '囲碁側を助ける', rules: { handicap: 'bishop' } },
  { k: 'stones2', label: '置き石2', note: '囲碁側を助ける', rules: { stones: 2 } },
  { k: 'goal-3', label: '石の目標−3', note: '将棋側を助ける', rules: { goalDelta: -3 } },
  { k: 'goal-6', label: '石の目標−6', note: '将棋側を大きく助ける', rules: { goalDelta: -6 } },
];
const SAVE_KEY = 'shogi-vs-go-v1';

const $ = (s, el) => (el || document).querySelector(s);
const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function rulesFor(hk) {
  const H = HANDI.find(x => x.k === hk) || HANDI[0];
  const r = Object.assign({}, E.DEFAULT_RULES);
  if (H.rules.handicap) r.handicap = H.rules.handicap;
  if (H.rules.stones) r.stones = H.rules.stones;
  if (H.rules.goalDelta) r.goal += H.rules.goalDelta;
  if (H.rules.takeDelta) r.take += H.rules.takeDelta;
  return r;
}

// ---- 対局状態 ----
const G = {
  mode: 'ai',      // 'ai' | 'pvp'
  human: SHOGI,    // AI対戦で人間が持つ側
  level: 1,
  handi: 'even',
  pos: new E.Pos(),
  snaps: [],       // 各局面 {state, label, side, move, gone, note}
  over: null,      // {winner, reason}
  sel: null,       // {kind:'piece'|'group', sq, targets?: Map(to -> [moves])}
  ghost: -1,       // 囲碁側: 置く前の確認中の升
  legal: [],
  thinking: false, hinting: false,
  info: null, hint: null, hintDepth: 0,
  flip: false,
  fresh: true,     // AI の置換表を消す（新しい対局）
};

function sqName(sq) { return FILE[sq % 9] + RANK[(sq / 9) | 0]; }
const isPiece = c => c > 0 && c < STONE;

function newGame(mode, human, level, handi) {
  G.mode = mode; G.human = human; G.level = level; G.handi = handi;
  G.pos = new E.Pos(rulesFor(handi));
  G.snaps = [{ state: G.pos.serialize(), label: null, move: null, gone: [] }];
  G.over = null; G.info = null; G.fresh = true;
  G.flip = mode === 'ai' && human === GO;
  cancelThink();
  afterPosition();
}

function restorePos() { G.pos.load(G.snaps[G.snaps.length - 1].state); }

function isHumanTurn() { return !G.over && (G.mode === 'pvp' || G.pos.side === G.human); }

let autoTimer = 0;
function afterPosition() {
  G.sel = null; G.ghost = -1; G.hint = null;
  clearTimeout(autoTimer);
  const p = G.pos;
  G.legal = G.over ? [] : p.legalMoves();
  if (!G.over && G.legal.length === 0) {
    if (p.side === GO) {
      const a = p.area();
      G.over = { winner: p.areaWinner(), reason: `置ける升がなくなったので地を数えました（囲碁 ${a.go}・将棋 ${a.shogi}）`, area: a };
    } else G.over = { winner: GO, reason: '将棋側の動かせる駒がなくなりました' };
  }
  save();
  render();
  if (G.over) return;
  if (G.legal.length === 1 && G.legal[0] === END_TURN) {
    // 2つ目の石を置ける場所がないときは手番を終える
    autoTimer = setTimeout(() => play(END_TURN), 700);
    return;
  }
  if (G.mode === 'ai' && p.side !== G.human) startThink();
}

// 1手指す
function play(m) {
  const p = G.pos, d = E.decode(m), mover = p.side;
  const before = Array.from(p.board);
  const capsBefore = p.caps;
  const pc = d.go ? 0 : p.board[d.from];
  const r = p.make(m);
  if (r < 0) return;
  p.usp = 0;
  const gone = [];
  for (let s = 0; s < 81; s++) if (before[s] && !p.board[s] && !(!d.go && s === d.from)) gone.push(s);
  let label, note = '';
  if (d.end) { label = '●置けずに手番終了'; }
  else if (d.go) {
    label = MARK[GO] + sqName(d.to);
    const lost = gone.map(s => KANJI[before[s]]);
    if (lost.length) note = lost.join('・') + 'を取る';
  } else {
    let canProm = E.PROMOTABLE[pc] && (E.ROW[d.from] <= 2 || E.ROW[d.to] <= 2);
    label = MARK[SHOGI] + sqName(d.to) + KANJI[pc] + (d.prom ? '成' : canProm ? '不成' : '');
    const got = p.caps - capsBefore;
    if (got) note = `石を${got}つ取る`;
    if (before[d.to] === STONE) gone.push(d.to);
  }
  G.snaps.push({ state: p.serialize(), label, side: mover, move: d.end ? null : d, gone, note });
  if (r > 0) {
    const a = p.area();
    let reason;
    if (mover === SHOGI) reason = `石を${p.goal}個取りました`;
    else if (p.kingSq < 0) reason = '玉を囲んで取りました';
    else if (p.placed >= p.supply) reason = `碁笥の石を置き終えたので地を数えました（囲碁 ${a.go}・将棋 ${a.shogi}）`;
    else reason = `駒を${p.take}枚取りました`;
    G.over = { winner: r === 1 ? mover : mover ^ 1, reason };
  }
  else if (G.snaps.length > 800) G.over = { winner: -1, reason: '手数が上限に達しました' };
  afterPosition();
}

// 手番の始まりか（待ったで戻る位置）
function turnStart(i) {
  const st = G.snaps[i].state;
  return i === 0 || st.side === SHOGI || st.left === (st.rules.perTurn || 2);
}

function undo() {
  if (G.snaps.length <= 1) return;
  cancelThink();
  clearTimeout(autoTimer);
  if (G.mode === 'pvp') G.snaps.length -= 1;
  else {
    do { G.snaps.length -= 1; }
    while (G.snaps.length > 1 && !(G.snaps[G.snaps.length - 1].state.side === G.human && turnStart(G.snaps.length - 1)));
  }
  G.over = null; G.info = null;
  restorePos();
  afterPosition();
}

// ---- AI ----
let worker = null, workerFailed = false, thinkId = 0;
function makeWorker() {
  if (worker || workerFailed) return worker;
  try {
    const src = $('#sg-engine').textContent + '\n' + WORKER_GLUE;
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
  if (!P) { P = new SG.Pos(); S = new SG.Searcher(P, 20); }
  if (d.fresh) S.clearTT();
  P.load(d.state);
  S.setPos(P);
  const r = S.think(d.time, 40, function (i) { self.postMessage({ type: 'info', id: d.id, kind: d.kind, info: { depth: i.depth, score: i.score } }); });
  self.postMessage({ type: 'done', id: d.id, kind: d.kind, move: r.move, score: r.score, depth: r.depth });
};`;

let mainSearcher = null;
function startThink(kind) {
  if (G.thinking || G.hinting || G.over) return;
  kind = kind || 'ai';
  if (kind === 'hint') { G.hinting = true; G.hint = null; G.hintDepth = 0; } else { G.thinking = true; }
  const id = ++thinkId;
  const msg = {
    id, kind, state: G.pos.serialize(), fresh: G.fresh,
    time: kind === 'hint' ? Math.min(Math.max(LEVELS[G.level].ms, 2500), 5000) : LEVELS[G.level].ms,
  };
  G.fresh = false;
  render();
  const w = makeWorker();
  if (w) { w.postMessage(msg); return; }
  // Worker が使えない環境ではメインスレッドで考える
  setTimeout(() => {
    if (id !== thinkId) return;
    const p = new E.Pos(); p.load(msg.state);
    if (!mainSearcher) mainSearcher = new E.Searcher(p, 18); else mainSearcher.setPos(p);
    if (msg.fresh) mainSearcher.clearTT();
    const r = mainSearcher.think(Math.min(msg.time, 3000), 40);
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
    if (G.legal.includes(d.move)) G.hint = { move: d.move, score: d.score, depth: d.depth };
    render();
    return;
  }
  G.thinking = false;
  G.info = { depth: d.depth, score: d.score, side: G.pos.side };
  if (G.over || !G.legal.includes(d.move)) { render(); return; }
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
  G.sel = null; G.ghost = -1;
  startThink('hint');
}

// ---- 盤面の読み取り（表示用） ----
// 次の囲碁の手番で取られうる駒の連と、玉の連の呼吸点
function threats() {
  const p = G.pos, b = p.board;
  const reach = p.side === GO ? p.left : p.perTurn;
  const risk = new Set();
  const seen = new Uint8Array(81);
  let kingLibs = -1;
  for (let s = 0; s < 81; s++) {
    if (!isPiece(b[s]) || seen[s]) continue;
    const g = p.groupInfo(s);
    for (const c of g.cells) seen[c] = 1;
    if (g.cells.includes(p.kingSq)) kingLibs = g.libs.length;
    if (g.libs.length <= reach) for (const c of g.cells) risk.add(c);
  }
  return { risk, kingLibs, reach };
}

// 囲碁側が石を置ける升の数（自殺手を除く）
function placeable() {
  const p = G.pos;
  let n = 0;
  for (let s = 0; s < 81; s++) {
    if (p.board[s]) continue;
    if (p.make(E.goMove(s)) >= 0) { p.unmake(); n++; }
  }
  return n;
}

// 石を置いたらどうなるか
function previewGo(sq) {
  const p = G.pos, m = E.goMove(sq);
  const before = Array.from(p.board);
  const r = p.make(m);
  if (r < 0) return null;
  const lost = [];
  for (let s = 0; s < 81; s++) if (isPiece(before[s]) && !p.board[s]) lost.push(KANJI[before[s]]);
  // 隣の駒の連の呼吸点
  const adj = [];
  const seen = new Set();
  for (const t of E.NEI[sq]) {
    if (!isPiece(p.board[t]) || seen.has(t)) continue;
    const g = p.groupInfo(t);
    for (const c of g.cells) seen.add(c);
    adj.push({ libs: g.libs.length, king: g.cells.includes(p.kingSq), n: g.cells.length });
  }
  const own = p.libertyCount(sq);
  p.unmake();
  return { lost, adj, own, win: r > 0 };
}

// ---- 保存 ----
function snapshotData() { return { mode: G.mode, human: G.human, level: G.level, handi: G.handi, flip: G.flip, snaps: G.snaps, over: G.over }; }
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(snapshotData())); } catch (e) { /* 保存できない環境でも遊べる */ }
}
function loadSaved(data) {
  try {
    const o = data || JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!o || !o.snaps || !o.snaps.length) return false;
    G.mode = o.mode; G.human = o.human; G.level = o.level ?? 1; G.handi = o.handi || 'even'; G.flip = !!o.flip;
    G.snaps = o.snaps; G.over = o.over || null;
    restorePos();
    return true;
  } catch (e) { return false; }
}

// ---- 描画 ----
function pieceEl(c, upright) {
  // 将棋側が盤の上にいるとき（反転時）は駒を下向きにする
  return h('div', 'piece' + (c > PROM ? ' prom' : '') + (G.flip && !upright ? ' down' : ''), KANJI[c]);
}
function stoneEl(cls) { return h('div', 'stone' + (cls ? ' ' + cls : '')); }

function render() {
  const p = G.pos, b = p.board;
  const app = $('.app');
  app.classList.toggle('t-shogi', p.side === SHOGI);
  app.classList.toggle('t-go', p.side === GO);
  const board = $('#board');
  board.textContent = '';
  const last = G.snaps[G.snaps.length - 1];
  // 直前の手番の石（囲碁の2つ）と駒の動き
  const newStones = new Set(), lastSq = new Set();
  for (let i = G.snaps.length - 1; i > 0; i--) {
    const s = G.snaps[i];
    if (s.side !== last.side) break;
    if (s.move && s.move.go) newStones.add(s.move.to);
    else if (s.move) { lastSq.add(s.move.from); lastSq.add(s.move.to); }
  }
  const gone = new Set(last.gone || []);
  const th = threats();
  const sel = G.sel;
  let grp = null;
  if (sel && b[sel.sq]) grp = p.groupInfo(sel.sq);
  const grpCells = new Set(grp ? grp.cells : []), grpLibs = new Set(grp ? grp.libs : []);
  let hint = null;
  if (G.hint) { const d = E.decode(G.hint.move); hint = d.end ? null : { from: d.go ? -1 : d.from, to: d.to }; }
  for (let i = 0; i < 81; i++) {
    const sq = G.flip ? 80 - i : i;
    const c = h('button', 'cell');
    c.type = 'button';
    c.dataset.sq = sq;
    const v = b[sq];
    c.setAttribute('aria-label', sqName(sq) + (v === STONE ? ' 石' : isPiece(v) ? ' ' + KANJI[v] : ''));
    if (lastSq.has(sq)) c.classList.add('last');
    if (v === STONE) c.appendChild(stoneEl(newStones.has(sq) ? 'new drop' : ''));
    else if (isPiece(v)) {
      c.appendChild(pieceEl(v));
      if (th.risk.has(sq) && !G.over) c.classList.add('risk');
    } else if (G.ghost === sq) c.appendChild(stoneEl('ghost'));
    if (gone.has(sq) && !v) c.classList.add('gone');
    if (sel) {
      if (sel.kind === 'piece' && sel.sq === sq) c.classList.add('sel');
      if (sel.kind === 'group' && grpCells.has(sq)) c.classList.add('grp');
      if (grpLibs.has(sq) && sel.kind === 'group') c.classList.add('lib');
      if (sel.targets && sel.targets.has(sq)) { c.classList.add('dest'); if (v) c.classList.add('cap'); }
    }
    if (hint) {
      if (hint.to === sq) c.classList.add('hint-to');
      if (hint.from === sq) c.classList.add('hint-from');
    }
    board.appendChild(c);
  }
  for (const [x, y] of [[3, 3], [6, 3], [3, 6], [6, 6]]) {
    const st = h('i', 'star');
    st.style.left = (x / 9 * 100) + '%'; st.style.top = (y / 9 * 100) + '%';
    board.appendChild(st);
  }
  $('#files').textContent = '';
  for (let i = 0; i < 9; i++) $('#files').appendChild(h('span', '', String(G.flip ? i + 1 : 9 - i)));
  $('#ranks').textContent = '';
  for (let i = 0; i < 9; i++) $('#ranks').appendChild(h('span', '', RANK[G.flip ? 8 - i : i]));
  renderPanel($('#panel-top'), G.flip ? SHOGI : GO, th);
  renderPanel($('#panel-bottom'), G.flip ? GO : SHOGI, th);
  renderStatus(th);
  renderInfo(th);
  renderLog();
  $('#undo').disabled = G.snaps.length <= 1;
  const hb = $('#hint');
  hb.disabled = !isHumanTurn() || G.thinking || G.hinting;
  hb.textContent = G.hinting ? '考え中…' : G.hint ? 'ヒントを消す' : 'ヒント';
  hb.classList.toggle('on', !!G.hint);
  if (G.over && !G.shownOver) { G.shownOver = true; showResult(); }
  if (!G.over) G.shownOver = false;
}

function playerName(side) {
  if (G.mode === 'pvp') return '';
  return side === G.human ? 'あなた' : 'AI';
}

function renderPanel(el, side, th) {
  const p = G.pos;
  el.textContent = '';
  el.classList.toggle('on', !G.over && p.side === side);
  const who = h('div', 'who');
  if (side === SHOGI) who.appendChild(h('span', 'mini-piece'));
  else who.appendChild(h('span', 'mini-stone'));
  who.appendChild(h('span', '', SIDE_NAME[side]));
  const tag = playerName(side);
  if (tag) who.appendChild(h('span', 'tag', tag));
  el.appendChild(who);
  const body = h('div', 'body');
  if (side === SHOGI) {
    const l1 = h('div', 'line');
    l1.append('取った石 ');
    const bb = h('b', '', `${p.caps}`); l1.appendChild(bb);
    l1.append(` / ${p.goal}`);
    const pr = h('span', 'progress'); const bar = h('i'); bar.style.width = Math.min(100, p.caps / p.goal * 100) + '%'; pr.appendChild(bar);
    l1.appendChild(pr);
    body.appendChild(l1);
    const danger = !G.over && th.kingLibs >= 0 && th.kingLibs <= th.reach;
    const l2 = h('div', 'line' + (danger ? ' warn' : ''));
    l2.append('玉の呼吸点 ');
    l2.appendChild(h('b', '', th.kingLibs >= 0 ? String(th.kingLibs) : '―'));
    if (danger) l2.append('（次で囲まれる）');
    body.appendChild(l2);
  } else {
    const l1 = h('div', 'line');
    l1.append('取った駒 ');
    const takeRule = p.take < 40; // 駒の数で勝つルールを使うとき
    if (takeRule) {
      l1.appendChild(h('b', '', String(p.lost)));
      l1.append(` / ${p.take}`);
      const pr = h('span', 'progress go'); const bar = h('i'); bar.style.width = Math.min(100, p.lost / p.take * 100) + '%'; pr.appendChild(bar);
      l1.appendChild(pr);
    }
    const dd = h('span', 'dead');
    for (const t of [1, 2, 3, 4, 5, 6, 7, 8]) for (let k = 0; k < p.dead[t]; k++) dd.appendChild(h('span', '', KANJI[t]));
    if (!p.lost) dd.appendChild(document.createTextNode('なし'));
    if (!takeRule) l1.appendChild(dd);
    body.appendChild(l1);
    if (takeRule && p.lost) body.appendChild(dd);
    const room = placeable();
    const l2 = h('div', 'line');
    l2.append('碁笥の残り ');
    l2.appendChild(h('b', '', String(Math.max(0, p.supply - p.placed))));
    l2.append('個　盤上の石 ');
    l2.appendChild(h('b', '', String(p.stones)));
    if (room <= 6 && !G.over) { l2.classList.add('warn'); l2.append(`　置ける升 ${room}`); }
    body.appendChild(l2);
  }
  el.appendChild(body);
  if (side === GO && p.side === GO && !G.over) {
    const sl = h('span', 'stones-left');
    sl.title = 'この手番で置ける残りの石';
    const total = turnTotal();
    for (let i = 0; i < total; i++) sl.appendChild(h('i', i < p.left ? 'full' : ''));
    el.appendChild(sl);
  }
}
// この手番に置ける石の数
function turnTotal() {
  const p = G.pos;
  for (let i = G.snaps.length - 1; i >= 0; i--) {
    const st = G.snaps[i].state;
    if (st.side !== GO) break;
    if (turnStart(i)) return st.left;
  }
  return p.perTurn;
}

function renderStatus(th) {
  const p = G.pos;
  th = th || threats();
  const pill = $('#turn');
  const msg = $('#msg');
  msg.classList.remove('alert');
  if (G.over) {
    pill.textContent = '終局';
    pill.className = 'turn-pill';
    msg.textContent = G.over.reason;
  } else {
    const mine = G.mode === 'ai' ? (p.side === G.human ? '（あなた）' : '（AI）') : '';
    pill.textContent = MARK[p.side] + SIDE_NAME[p.side] + mine;
    pill.className = 'turn-pill' + (isHumanTurn() ? ' mine' : '');
    if (G.hinting) msg.textContent = 'おすすめの手を探しています…' + (G.hintDepth ? `（${G.hintDepth}手先まで）` : '');
    else if (G.thinking) msg.textContent = 'AI が読んでいます…' + (G.info && G.info.depth ? `（${G.info.depth}手先まで）` : '');
    else if (!isHumanTurn()) msg.textContent = '';
    else if (p.side === SHOGI) {
      if (th.kingLibs >= 0 && th.kingLibs <= p.perTurn) { msg.textContent = `玉の呼吸点が残り${th.kingLibs}。次の手番で囲まれます`; msg.classList.add('alert'); }
      else if (G.sel && G.sel.kind === 'piece') msg.textContent = '動かす先を選んでください';
      else msg.textContent = '駒を選んでください';
    } else {
      if (G.ghost >= 0) msg.textContent = 'もう一度タップすると置きます';
      else msg.textContent = `石を置く升をタップ（あと${p.left}つ）`;
    }
  }
  // 形勢メーター（あなたから見た評価）
  const meter = $('#meter > i');
  let pct = 50;
  if (G.info && G.info.score != null && G.mode === 'ai') {
    let sc = G.info.side === G.human ? G.info.score : -G.info.score;
    if (Math.abs(sc) > 900000) sc = sc > 0 ? 3000 : -3000;
    pct = 50 + 50 * Math.tanh(sc / 1500);
  }
  meter.style.width = pct.toFixed(1) + '%';
  $('#meter').hidden = G.mode !== 'ai';
  $('#meter').title = 'あなたから見た形勢（AIの読み）';
}

function describeMove(m) {
  const p = G.pos, d = E.decode(m);
  if (d.end) return { mark: '手番終了', where: '置ける場所がありません' };
  if (d.go) {
    const pv = previewGo(d.to);
    let where = `${sqName(d.to)}に石を置く`;
    if (pv && pv.lost.length) where += `（${pv.lost.join('・')}を取る）`;
    return { mark: MARK[GO] + sqName(d.to), where };
  }
  const pc = p.board[d.from], tgt = p.board[d.to];
  return {
    mark: MARK[SHOGI] + sqName(d.to) + KANJI[pc] + (d.prom ? '成' : ''),
    where: `${sqName(d.from)}の${KANJI[pc]}を${sqName(d.to)}へ` + (tgt === STONE ? '（石を取る）' : ''),
  };
}

function renderInfo(th) {
  const box = $('#info');
  box.textContent = '';
  const p = G.pos, b = p.board;
  if (G.hint && !G.sel && G.ghost < 0) {
    const d = describeMove(G.hint.move);
    const r1 = h('div', 'row');
    r1.appendChild(h('span', 'hint-tag', 'おすすめ'));
    r1.appendChild(h('span', 'hint-move', d.mark));
    r1.appendChild(h('span', 'label', d.where));
    box.appendChild(r1);
    const r2 = h('div', 'row');
    const sc = G.hint.score;
    let verdict;
    if (sc > 900000) verdict = 'この手で勝ちが見えています';
    else if (sc < -900000) verdict = '苦しい局面です。いちばん粘れる手を選びました';
    else verdict = `${G.hint.depth}手先まで読んだ結果です`;
    r2.appendChild(h('span', 'label', verdict));
    const go = h('button', 'btn primary small', 'この手を指す');
    go.type = 'button';
    go.onclick = () => { if (G.hint && isHumanTurn()) play(G.hint.move); };
    r2.appendChild(go);
    box.appendChild(r2);
    return;
  }
  if (G.ghost >= 0) {
    const pv = previewGo(G.ghost);
    const r = h('div', 'row');
    r.appendChild(h('span', 'chip', sqName(G.ghost)));
    if (pv.win) r.appendChild(h('span', 'chip warn', '玉を取って勝ち'));
    else if (pv.lost.length) r.appendChild(h('span', 'label', `${pv.lost.join('・')}を取ります`));
    else {
      const parts = pv.adj.map(a => `${a.king ? '玉の連' : '隣の駒'}の呼吸点 ${a.libs}`);
      r.appendChild(h('span', 'label', parts.length ? parts.join('　') : '置いた石の呼吸点 ' + pv.own));
    }
    box.appendChild(r);
    const r2 = h('div', 'row');
    r2.appendChild(h('span', 'label', '同じ升をもう一度タップで置きます。別の升を選び直せます。'));
    box.appendChild(r2);
    return;
  }
  if (G.sel && b[G.sel.sq]) {
    const g = p.groupInfo(G.sel.sq);
    const v = b[G.sel.sq];
    const r = h('div', 'row');
    if (v === STONE) {
      r.appendChild(h('span', 'label', `石の連 ${g.cells.length}個`));
      r.appendChild(h('span', 'label', '呼吸点'));
      r.appendChild(h('b', '', String(g.libs.length)));
      box.appendChild(r);
      const r2 = h('div', 'row');
      r2.appendChild(h('span', 'label', g.libs.length === 1 ? '最後の呼吸点を駒でふさぐと、連ごと取れます' : '○の升（呼吸点）を駒で全部ふさぐと、連ごと取れます'));
      box.appendChild(r2);
    } else {
      const inKing = g.cells.includes(p.kingSq);
      r.appendChild(h('span', 'label', `${inKing ? '玉を含む' : ''}駒の連 ${g.cells.length}枚`));
      r.appendChild(h('span', 'label', '呼吸点'));
      const warn = g.libs.length <= th.reach;
      r.appendChild(h('b', warn ? 'chip warn' : '', String(g.libs.length)));
      box.appendChild(r);
      const r2 = h('div', 'row');
      let t;
      if (warn) t = `次の囲碁の手番（${th.reach}つ置く）で囲まれて取られます`;
      else if (G.sel.kind === 'piece') t = G.sel.targets.size ? '点の升へ動けます。石の上に動くと石を取ります' : 'この駒は今動けません';
      else t = '○の升（呼吸点）を石で全部ふさぐと、連ごと取れます';
      r2.appendChild(h('span', 'label', t));
      box.appendChild(r2);
    }
    return;
  }
  const r = h('div', 'row');
  if (G.over) r.appendChild(h('span', 'label', '盤の駒や石をタップすると、連と呼吸点を確かめられます。'));
  else if (p.side === SHOGI) r.appendChild(h('span', 'label', `将棋側は、碁笥の石がなくなる前に石を${p.goal}個取れば勝ち。赤い点の駒は、次の囲碁の手番で囲まれて取られます。`));
  else r.appendChild(h('span', 'label', `囲碁側は玉を囲むか、将棋側に${p.goal}個取られる前に碁笥の${p.supply}個を置き終えれば勝ち（地を数える）。駒をタップすると呼吸点が見えます。`));
  box.appendChild(r);
}

function renderLog() {
  const ol = $('#log-list');
  ol.textContent = '';
  for (let i = 1; i < G.snaps.length; i++) {
    const s = G.snaps[i];
    const li = h('li');
    li.appendChild(h('span', 'm ' + (s.side === SHOGI ? 's' : 'g'), s.label));
    if (s.note) li.appendChild(h('span', 'q', '　' + s.note));
    ol.appendChild(li);
  }
  $('#log-count').textContent = String(G.snaps.length - 1);
  ol.scrollTop = ol.scrollHeight;
}

// ---- 操作 ----
function selectPiece(sq) {
  const targets = new Map();
  for (const m of G.legal) {
    if (m === END_TURN || (m & 127) !== sq) continue;
    const to = (m >> 7) & 127;
    if (!targets.has(to)) targets.set(to, []);
    targets.get(to).push(m);
  }
  G.sel = { kind: 'piece', sq, targets };
  render();
}

function onBoardTap(sq) {
  const p = G.pos, v = p.board[sq];
  const myTurn = isHumanTurn() && !G.thinking;
  if (myTurn && p.side === SHOGI) {
    if (G.sel && G.sel.targets && G.sel.targets.has(sq)) { chooseMove(G.sel.targets.get(sq)); return; }
    if (isPiece(v)) {
      if (G.sel && G.sel.sq === sq) { G.sel = null; render(); return; }
      selectPiece(sq);
      return;
    }
  }
  if (myTurn && p.side === GO && !v) {
    G.sel = null;
    const m = E.goMove(sq);
    if (!G.legal.includes(m)) {
      G.ghost = -1; render();
      const msg = $('#msg'); msg.textContent = 'そこは呼吸点のない升なので置けません（自殺手）'; msg.classList.add('alert');
      return;
    }
    if (G.ghost === sq) { play(m); return; }
    G.ghost = sq; G.hint = null;
    render();
    return;
  }
  // 連と呼吸点を見る（いつでも）
  G.ghost = -1;
  if (v) {
    if (G.sel && G.sel.sq === sq && G.sel.kind === 'group') G.sel = null;
    else G.sel = { kind: 'group', sq };
  } else G.sel = null;
  render();
}

function chooseMove(moves) {
  if (moves.length === 1) { play(moves[0]); return; }
  const p = G.pos;
  const sheet = openSheet();
  sheet.appendChild(h('h2', '', '成りますか？'));
  const box = h('div', 'prom-choice');
  for (const m of [...moves].sort((a, b) => ((b >> 14) & 1) - ((a >> 14) & 1))) {
    const d = E.decode(m), pc = p.board[d.from];
    const b = h('button', 'opt');
    b.type = 'button';
    b.appendChild(h('b', '', d.prom ? '成る' : '成らない'));
    b.appendChild(h('span', 'chars' + (d.prom ? ' p' : ''), KANJI[d.prom ? pc + PROM : pc]));
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
  let level = G.level, handi = G.handi;
  const modes = [
    { k: 'ai0', cls: 's', label: '将棋側で指す', note: '駒で石を取る（AIは囲碁）' },
    { k: 'ai1', cls: 'g', label: '囲碁側で打つ', note: '石で玉を囲む（AIは将棋）' },
    { k: 'pvp', cls: '', label: '2人で対戦', note: '1台のスマホで交互に' },
  ];
  let cur = G.mode === 'pvp' ? 'pvp' : 'ai' + G.human;
  sh.appendChild(h('h3', '', '対戦相手'));
  const mo = h('div', 'opts'), lv = h('div', 'opts'), hd = h('div', 'opts');
  const lvTitle = h('h3', '', 'AIの強さ（考える時間）');
  const draw = () => {
    mo.textContent = ''; lv.textContent = ''; hd.textContent = '';
    for (const m of modes) {
      const b = h('button', 'opt ' + m.cls + (cur === m.k ? ' on' : ''));
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
    for (const H of HANDI) {
      const b = h('button', 'opt' + (handi === H.k ? ' on' : ''));
      b.type = 'button';
      b.appendChild(h('b', '', H.label)); b.appendChild(h('small', '', H.note));
      b.onclick = () => { handi = H.k; draw(); };
      hd.appendChild(b);
    }
    lvTitle.hidden = lv.hidden = cur === 'pvp';
  };
  draw();
  sh.appendChild(mo); sh.appendChild(lvTitle); sh.appendChild(lv);
  sh.appendChild(h('h3', '', '手合い'));
  sh.appendChild(hd);
  const act = h('div', 'actions');
  const c = h('button', 'btn', 'キャンセル'); c.type = 'button'; c.onclick = closeSheet;
  const ok = h('button', 'btn primary', '対局開始'); ok.type = 'button';
  ok.onclick = () => {
    closeSheet();
    if (cur === 'pvp') newGame('pvp', SHOGI, level, handi); else newGame('ai', cur === 'ai1' ? GO : SHOGI, level, handi);
  };
  act.appendChild(c); act.appendChild(ok); sh.appendChild(act);
}

function fig(cells, cap) {
  const w = h('div');
  w.style.display = 'flex'; w.style.flexDirection = 'column'; w.style.alignItems = 'center'; w.style.gap = '4px';
  const f = h('div', 'fig');
  for (const x of cells) {
    const s = h('span');
    if (x === '●') s.appendChild(stoneEl(''));
    else if (x !== '・') s.appendChild(pieceEl(+Object.keys(KANJI).find(k => KANJI[k] === x), true));
    f.appendChild(s);
  }
  w.appendChild(f);
  w.appendChild(h('div', 'cap', cap));
  return w;
}

function showRules() {
  const p = G.pos;
  const sh = openSheet();
  sh.appendChild(h('h2', '', '将棋対囲碁のルール'));
  sh.appendChild(h('p', '', '9×9の盤で、駒を動かす将棋側と、石を置く囲碁側が戦います。将棋盤の81升は9路盤の81か所と同じ数なので、石は升の中に置きます。'));
  const figs = h('div', 'rules-fig');
  figs.appendChild(fig(['・', '●', '・', '・', '銀', '・', '・', '・', '・'], '駒は石の上に動いて石を取る'));
  figs.appendChild(fig(['・', '●', '・', '●', '歩', '●', '・', '●', '・'], '石は駒を囲んで取る'));
  sh.appendChild(figs);
  sh.insertAdjacentHTML('beforeend', `
    <h3>将棋側（駒）</h3>
    <ul>
      <li>駒の並べ方・動き・成りは将棋と同じです。</li>
      <li>石のある升へ動くと、その石を取ります。石は飛び越えられません（桂馬は跳べます）。</li>
      <li>取った石は持ち駒になりません。数を数えるだけです。</li>
    </ul>
    <h3>囲碁側（石）</h3>
    <ul>
      <li>囲碁側から始めます。空いている升に石を置きます。<b>1回の手番に石を${p.perTurn}つ</b>置きます（最初の手番だけ1つ）。</li>
      <li>碁笥（石の入れ物）には<b>${p.supply}個</b>の石があります。取られた石は戻りません。</li>
      <li>上下左右につながった石や駒は「連」になります。連のとなりの空き升が「呼吸点」です。</li>
      <li>石を置いて、駒の連の呼吸点をすべてふさぐと、その連の駒をまとめて取ります。</li>
    </ul>
    <h3>両方に共通（囲碁のルール）</h3>
    <ul>
      <li>将棋側も、駒で石の連の呼吸点をすべてふさげば、その石をまとめて取れます。</li>
      <li>自分の連の呼吸点がなくなる手（自殺手）は指せません。ただし相手の連を取れる場合は指せます。</li>
    </ul>
    <h3>勝ち負け</h3>
    <ul>
      <li><b>将棋側の勝ち</b>：石を<b>${p.goal}個</b>取る。</li>
      <li><b>囲碁側の勝ち</b>：${p.take < 40 ? `駒を<b>${p.take}枚</b>取る。または` : ''}玉を取る（玉を含む駒の連を囲む）。</li>
      <li><b>碁笥の石を置き終えたら</b>：終局して、囲碁と同じく地を数えます。自分の石・駒の数と、自分だけに囲まれた空き升の数の合計が多い方の勝ちです（同じなら将棋側の勝ち）。ふつうは囲碁側が勝つので、将棋側はそれまでに石を${p.goal}個取る必要があります。</li>
      <li>囲碁側が石を置ける升（自殺手にならない空き升）がなくなったときも、同じように地を数えて終局します。</li>
      <li>将棋側は動かせる駒がなくなったら負けです。王手の決まりはありません。囲碁側はパスできません。</li>
    </ul>
    <h3>互角にするための調整</h3>
    <ul>
      <li>元のルールのままだと、駒が毎手石を1つ取れる将棋側が圧倒的に有利でした（将棋側の目標を45個にしても8戦全勝）。そこで囲碁側は1手番に石を2つ置きます。</li>
      <li>それでも将棋側は石を食べ続けられるので、囲碁側の石の数を碁笥の${p.supply}個までにし、置き終えたら地を数えることにしました（実際の碁も、地を数えて勝ち負けを決めます）。</li>
      <li>将棋側の目標の石の数は、AI同士を何百局も対局させて、勝率が半々に近くなるように選びました。</li>
    </ul>
    <h3>画面の見方</h3>
    <ul>
      <li>赤い点の駒は、次の囲碁の手番で囲まれて取られる駒です。</li>
      <li>駒や石をタップすると、その連と呼吸点（○）が表示されます。</li>
      <li>囲碁側は、升を1回タップで仮置き、もう1回タップで置きます。</li>
    </ul>`);
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
  else text = SIDE_NAME[o.winner] + '側の勝ち';
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
  $('#new').onclick = showNewGame;
  $('#rules').onclick = showRules;
  $('#undo').onclick = undo;
  $('#hint').onclick = requestHint;
  $('#flip').onclick = () => { G.flip = !G.flip; render(); };
  window.addEventListener('resize', layout);
  if (loadSaved(data && data.game)) afterPosition();
  else newGame('ai', SHOGI, 1, 'even');
  layout();
  if (window.claude && window.claude.hot && window.claude.hot.snapshot) {
    window.claude.hot.snapshot(() => ({ game: snapshotData() }));
  }
}

const hot = window.claude && window.claude.hot;
if (hot && hot.ready) hot.ready(start); else start((hot && hot.data) || {});
})();
