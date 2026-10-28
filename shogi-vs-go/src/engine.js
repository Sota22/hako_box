// 将棋対囲碁エンジン（ルール判定＋AI探索）
// ブラウザ（メインスレッド / Web Worker）と Node.js の両方で動く単一ファイル。
(function (root) {
'use strict';

// ---- 駒と石 -------------------------------------------------------------
// 盤の値: 0 空き, 1..16 将棋の駒, 20 碁石
const EMPTY = 0, K = 1, R = 2, B = 3, G = 4, S = 5, N = 6, L = 7, P = 8;
const PROM = 8; // 成駒 = 元の駒 + 8（龍10 馬11 全13 圭14 杏15 と16）
const STONE = 20;
const SHOGI = 0, GO = 1; // 手番
const PROMOTABLE = new Uint8Array(32);
for (const c of [R, B, S, N, L, P]) PROMOTABLE[c] = 1;

// ---- 盤の幾何 -----------------------------------------------------------
// sq = row*9 + col。row 0 が上（一段目）、col 0 が左（9筋）。将棋側は下から上へ進む。
const ROW = new Int8Array(81), COL = new Int8Array(81);
for (let s = 0; s < 81; s++) { ROW[s] = (s / 9) | 0; COL[s] = s % 9; }
// 方向: 0上 1下 2左 3右 4左上 5右上 6左下 7右下
const DR = [-1, 1, 0, 0, -1, -1, 1, 1], DC = [0, 0, -1, 1, -1, 1, -1, 1];
const RAYS = [];
for (let d = 0; d < 8; d++) {
  RAYS.push([]);
  for (let s = 0; s < 81; s++) {
    const r = [];
    let y = ROW[s] + DR[d], x = COL[s] + DC[d];
    while (y >= 0 && y < 9 && x >= 0 && x < 9) { r.push(y * 9 + x); y += DR[d]; x += DC[d]; }
    RAYS[d].push(Int8Array.from(r));
  }
}
const NEI = []; // 上下左右（呼吸点の判定用）
for (let s = 0; s < 81; s++) {
  const r = [];
  for (let d = 0; d < 4; d++) { const y = ROW[s] + DR[d], x = COL[s] + DC[d]; if (y >= 0 && y < 9 && x >= 0 && x < 9) r.push(y * 9 + x); }
  NEI.push(Int8Array.from(r));
}
const GOLD_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
const STEP_DEF = [];
STEP_DEF[K] = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
STEP_DEF[G] = GOLD_D;
STEP_DEF[S] = [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]];
STEP_DEF[N] = [[-2, -1], [-2, 1]];
STEP_DEF[P] = [[-1, 0]];
STEP_DEF[R + PROM] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
STEP_DEF[B + PROM] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
for (const c of [S, N, L, P]) STEP_DEF[c + PROM] = GOLD_D;
const SLIDE_DEF = [];
SLIDE_DEF[R] = SLIDE_DEF[R + PROM] = [0, 1, 2, 3];
SLIDE_DEF[B] = SLIDE_DEF[B + PROM] = [4, 5, 6, 7];
SLIDE_DEF[L] = [0];
const STEPS = [], SLIDES = [];
for (let c = 0; c < 32; c++) {
  STEPS.push(null); SLIDES.push(SLIDE_DEF[c] ? Int8Array.from(SLIDE_DEF[c]) : new Int8Array(0));
  if (!STEP_DEF[c]) continue;
  const arr = [];
  for (let s = 0; s < 81; s++) {
    const r = [];
    for (const [dr, dc] of STEP_DEF[c]) {
      const y = ROW[s] + dr, x = COL[s] + dc;
      if (y >= 0 && y < 9 && x >= 0 && x < 9) r.push(y * 9 + x);
    }
    arr.push(Int8Array.from(r));
  }
  STEPS[c] = arr;
}

// ---- 手の表現 -----------------------------------------------------------
// 将棋の手: from | to<<7 | 成り<<14 、 囲碁の手: 127 | to<<7 、 0: 囲碁側の手番を終える（置ける所がないとき）
const GO_FROM = 127, END_TURN = 0;
const goMove = to => GO_FROM | (to << 7);
function decode(m) {
  if (m === END_TURN) return { go: true, end: true };
  const from = m & 127;
  return from === GO_FROM ? { go: true, to: (m >> 7) & 127 } : { go: false, from, to: (m >> 7) & 127, prom: (m >> 14) & 1 };
}

// ---- Zobrist ------------------------------------------------------------
let seed = 0x2545f491 | 0;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; }
const ZB1 = new Int32Array(81 * 32), ZB2 = new Int32Array(81 * 32);
const ZC1 = new Int32Array(256), ZC2 = new Int32Array(256);
const ZT1 = new Int32Array(16), ZT2 = new Int32Array(16); // 手番と、その手番で置ける残りの石数
for (let i = 0; i < ZB1.length; i++) { ZB1[i] = rnd(); ZB2[i] = rnd(); }
for (let i = 0; i < 256; i++) { ZC1[i] = rnd(); ZC2[i] = rnd(); }
for (let i = 0; i < 16; i++) { ZT1[i] = rnd(); ZT2[i] = rnd(); }

// ---- 初期配置と手合 -----------------------------------------------------
const START_ROWS = [
  [8, [L, N, S, G, K, G, S, N, L]],
  [7, [0, B, 0, 0, 0, 0, 0, R, 0]],
  [6, [P, P, P, P, P, P, P, P, P]],
];
// 駒落ち（将棋側のハンデ）: 取り除く升
const HANDICAPS = {
  none: [],
  lance: [80],          // 香落ち
  bishop: [64],         // 角落ち
  rook: [70],           // 飛車落ち
  two: [64, 70],        // 二枚落ち
};
// 置き石（囲碁側のハンデ）
const STAR = { 0: [], 1: [22], 2: [20, 24], 3: [20, 24, 22], 4: [20, 24, 38, 42] };

// 勝ち負け: 囲碁側は玉を取れば勝ち。将棋側は石を goal 個取れば勝ち。
// 囲碁側が手番の初めに置ける升がなければ終局し、地を数えて多い方の勝ち。将棋側は動かせる駒がなければ負け。
// goal: 将棋側の勝ちに必要な石の数, perTurn: 囲碁側が1手番に置く石の数,
// firstTurn: 囲碁側が先手のときの最初の手番に置く数, eatChain: つながった石も駒で取れるか
// supply: 囲碁側の碁笥の石の数。置き終わったら終局して地を数える
// take: 囲碁側の勝ちに必要な駒の数（99 は使わない。玉を取ればその時点で勝ち）
const DEFAULT_RULES = { goal: 37, supply: 100, take: 99, first: GO, perTurn: 2, firstTurn: 1, eatChain: true, handicap: 'none', stones: 0 };

const MAXUNDO = 1 << 16;
class Pos {
  constructor(rules) {
    this.board = new Int8Array(81);
    this.dead = new Uint8Array(32); // 囲碁側に取られた駒（元の駒の種類ごと）
    this.u = new Int32Array(MAXUNDO);
    this.vis = new Int32Array(81); this.stamp = 1;
    this.stack = new Int8Array(96);
    this.grp = new Int8Array(81); this.grpLen = 0;
    this.setRules(rules);
    this.initial();
  }

  setRules(rules) {
    this.rules = Object.assign({}, DEFAULT_RULES, rules || {});
    this.goal = this.rules.goal;
    this.take = this.rules.take;
    this.supply = this.rules.supply;
    this.perTurn = this.rules.perTurn;
    this.eatChain = !!this.rules.eatChain;
  }

  initial() {
    const b = this.board;
    b.fill(0);
    for (const [r, row] of START_ROWS) for (let c = 0; c < 9; c++) if (row[c]) b[r * 9 + c] = row[c];
    for (const sq of HANDICAPS[this.rules.handicap] || []) b[sq] = 0;
    this.stones = 0;
    for (const sq of STAR[this.rules.stones] || []) { b[sq] = STONE; this.stones++; }
    this.kingSq = 76;
    this.side = this.rules.first;
    this.left = this.side === GO ? this.rules.firstTurn : 0;
    this.caps = 0; this.placed = 0; this.dead.fill(0); this.lost = 0;
    this.usp = 0;
    this.rehash();
  }

  turnKey() { return this.side === GO ? 8 + this.left : 0; }

  rehash() {
    let h1 = 0, h2 = 0;
    for (let s = 0; s < 81; s++) if (this.board[s]) { h1 ^= ZB1[s * 32 + this.board[s]]; h2 ^= ZB2[s * 32 + this.board[s]]; }
    h1 ^= ZC1[this.caps & 255]; h2 ^= ZC2[this.caps & 255];
    const t = this.turnKey();
    h1 ^= ZT1[t]; h2 ^= ZT2[t];
    this.h1 = h1; this.h2 = h2;
  }

  serialize() {
    return { board: Array.from(this.board), side: this.side, left: this.left, caps: this.caps, placed: this.placed, dead: Array.from(this.dead), rules: this.rules };
  }
  load(o) {
    this.setRules(o.rules);
    this.board.set(o.board);
    this.side = o.side; this.left = o.left || 0; this.caps = o.caps; this.placed = o.placed || 0;
    this.dead.fill(0); if (o.dead) this.dead.set(o.dead);
    this.lost = 0; for (let i = 0; i < 32; i++) this.lost += this.dead[i];
    this.stones = 0; this.kingSq = -1;
    for (let s = 0; s < 81; s++) { if (this.board[s] === STONE) this.stones++; else if (this.board[s] === K) this.kingSq = s; }
    this.usp = 0;
    this.rehash();
  }

  // sq を含む連（同じ側の上下左右のつながり）に呼吸点があるか。
  // 無い場合は this.grp[0..grpLen) に連の升が入る。
  hasLiberty(sq) {
    const b = this.board, stone = b[sq] === STONE;
    const st = ++this.stamp, vis = this.vis, stack = this.stack, grp = this.grp;
    let sp = 0, n = 0;
    stack[sp++] = sq; vis[sq] = st;
    while (sp > 0) {
      const s = stack[--sp];
      grp[n++] = s;
      const nb = NEI[s];
      for (let i = 0; i < nb.length; i++) {
        const t = nb[i], c = b[t];
        if (c === 0) return true;
        if (vis[t] !== st && (c === STONE) === stone) { vis[t] = st; stack[sp++] = t; }
      }
    }
    this.grpLen = n;
    return false;
  }

  // 呼吸点の数（連全体）
  libertyCount(sq) {
    const b = this.board, stone = b[sq] === STONE;
    const st = ++this.stamp, vis = this.vis, stack = this.stack;
    let sp = 0, libs = 0;
    stack[sp++] = sq; vis[sq] = st;
    while (sp > 0) {
      const s = stack[--sp];
      const nb = NEI[s];
      for (let i = 0; i < nb.length; i++) {
        const t = nb[i];
        if (vis[t] === st) continue;
        const c = b[t];
        if (c === 0) { vis[t] = st; libs++; }
        else if ((c === STONE) === stone) { vis[t] = st; stack[sp++] = t; }
      }
    }
    return libs;
  }

  // 連の升と呼吸点の一覧（画面表示用）
  groupInfo(sq) {
    const b = this.board, stone = b[sq] === STONE;
    const cells = [], libs = [];
    const seen = new Uint8Array(81);
    const st = [sq]; seen[sq] = 1;
    while (st.length) {
      const s = st.pop(); cells.push(s);
      for (const t of NEI[s]) {
        if (seen[t]) continue;
        const c = b[t];
        if (c === 0) { seen[t] = 1; libs.push(t); }
        else if ((c === STONE) === stone) { seen[t] = 1; st.push(t); }
      }
    }
    return { cells, libs };
  }

  // 駒で取れる石か（つながった石を取れないルールのとき）
  edible(sq) {
    if (this.eatChain) return true;
    const nb = NEI[sq], b = this.board;
    for (let i = 0; i < nb.length; i++) if (b[nb[i]] === STONE) return false;
    return true;
  }

  _remove(n) {
    // grp[0..n) を盤から取り除き、undo に積む
    const b = this.board, u = this.u, grp = this.grp;
    let usp = this.usp, h1 = this.h1, h2 = this.h2;
    for (let i = 0; i < n; i++) {
      const s = grp[i], c = b[s];
      u[usp++] = s | (c << 8);
      h1 ^= ZB1[s * 32 + c]; h2 ^= ZB2[s * 32 + c];
      b[s] = 0;
    }
    this.usp = usp; this.h1 = h1; this.h2 = h2;
  }

  // 1手指す。戻り値: -1 不正（自殺手）, 0 通常, 1 指した側の勝ち, 2 指した側の負け（碁笥の石が尽きて地で負け）
  make(m) {
    const b = this.board, u = this.u;
    const from = m & 127, to = (m >> 7) & 127;
    const base = this.usp;
    const h1p = this.h1, h2p = this.h2, capsP = this.caps, kingP = this.kingSq, stonesP = this.stones;
    const sideP = this.side, leftP = this.left;
    let removed = 0, win = 0, mv = 0;
    if (m === END_TURN) {
      // 置ける所がないときだけ使う（手番を将棋側へ）
    } else if (from === GO_FROM) {
      // 囲碁: 石を置く → 呼吸点の無くなった駒の連を取る → 自殺手は不可
      b[to] = STONE; this.stones++; this.placed++;
      this.h1 ^= ZB1[to * 32 + STONE]; this.h2 ^= ZB2[to * 32 + STONE];
      const nb = NEI[to];
      for (let i = 0; i < nb.length; i++) {
        const t = nb[i], c = b[t];
        if (c === 0 || c === STONE) continue;
        if (!this.hasLiberty(t)) {
          const n = this.grpLen;
          for (let j = 0; j < n; j++) {
            const pc = b[this.grp[j]];
            if (pc === K) { win = 1; this.kingSq = -1; }
            this.dead[pc > PROM ? pc - PROM : pc]++;
          }
          this._remove(n); removed += n; this.lost += n;
        }
      }
      if (this.lost >= this.take) win = 1;
      // 碁笥の石を置き終えたら終局して地を数える
      if (!win && this.placed >= this.supply) win = this.areaWinner() === GO ? 1 : 2;
      if (!removed && !this.hasLiberty(to)) {
        b[to] = 0; this.stones--; this.placed--;
        this.h1 = h1p; this.h2 = h2p; this.usp = base;
        return -1;
      }
    } else {
      // 将棋: 駒を動かす（石の上に動けば取る） → 呼吸点の無くなった石の連を取る → 自殺手は不可
      const pc = b[from], tgt = b[to];
      const npc = (m >> 14) & 1 ? pc + PROM : pc;
      this.h1 ^= ZC1[this.caps & 255]; this.h2 ^= ZC2[this.caps & 255];
      if (tgt === STONE) {
        this.caps++; this.stones--;
        this.h1 ^= ZB1[to * 32 + STONE]; this.h2 ^= ZB2[to * 32 + STONE];
      }
      b[from] = 0; b[to] = npc;
      this.h1 ^= ZB1[from * 32 + pc] ^ ZB1[to * 32 + npc];
      this.h2 ^= ZB2[from * 32 + pc] ^ ZB2[to * 32 + npc];
      if (pc === K) this.kingSq = to;
      const nb = NEI[to];
      for (let i = 0; i < nb.length; i++) {
        const t = nb[i];
        if (b[t] !== STONE) continue;
        if (!this.hasLiberty(t)) {
          const n = this.grpLen;
          this._remove(n); removed += n;
          this.caps += n; this.stones -= n;
        }
      }
      if (!removed && !this.hasLiberty(to)) {
        b[to] = tgt; b[from] = pc;
        this.caps = capsP; this.stones = stonesP; this.kingSq = kingP;
        this.h1 = h1p; this.h2 = h2p; this.usp = base;
        return -1;
      }
      this.h1 ^= ZC1[this.caps & 255]; this.h2 ^= ZC2[this.caps & 255];
      mv = pc | (tgt << 8);
      if (this.caps >= this.goal) win = 1;
    }
    // 手番の更新（囲碁側は1手番に perTurn 個置く）
    const t0 = this.turnKey();
    if (sideP === SHOGI) { this.side = GO; this.left = this.perTurn; }
    else if (m === END_TURN || --this.left <= 0) { this.side = SHOGI; this.left = 0; }
    const t1 = this.turnKey();
    this.h1 ^= ZT1[t0] ^ ZT1[t1]; this.h2 ^= ZT2[t0] ^ ZT2[t1];
    u[this.usp++] = mv;
    u[this.usp++] = removed;
    u[this.usp++] = m;
    u[this.usp++] = capsP | (stonesP << 8) | ((kingP + 1) << 16) | (leftP << 24) | (sideP << 28);
    u[this.usp++] = h1p;
    u[this.usp++] = h2p;
    return win;
  }

  unmake() {
    const b = this.board, u = this.u;
    const h2p = u[--this.usp], h1p = u[--this.usp], meta = u[--this.usp], m = u[--this.usp], removed = u[--this.usp];
    const mv = u[--this.usp];
    const from = m & 127, to = (m >> 7) & 127;
    const goMv = m !== END_TURN && from === GO_FROM;
    // 取られた連を戻す
    for (let i = 0; i < removed; i++) {
      const x = u[--this.usp], s = x & 255, c = x >> 8;
      b[s] = c;
      if (goMv) { this.dead[c > PROM ? c - PROM : c]--; this.lost--; }
    }
    if (m !== END_TURN) {
      if (goMv) { b[to] = 0; this.placed--; }
      else { b[from] = mv & 255; b[to] = mv >> 8; }
    }
    this.caps = meta & 255; this.stones = (meta >> 8) & 255; this.kingSq = ((meta >> 16) & 255) - 1;
    this.left = (meta >> 24) & 15; this.side = (meta >> 28) & 1;
    this.h1 = h1p; this.h2 = h2p;
  }

  // 疑似合法手の生成。mode 0: 探索用（飛角歩の不成は省く） 1: すべて 2: targets の升への手だけ
  gen(buf, off, mode, targets) {
    const b = this.board;
    let n = off;
    if (this.side === GO) {
      if (mode === 2) {
        for (let s = 0; s < 81; s++) if (targets[s] && b[s] === 0) buf[n++] = GO_FROM | (s << 7);
      } else {
        for (let s = 0; s < 81; s++) if (b[s] === 0) buf[n++] = GO_FROM | (s << 7);
      }
      return n - off;
    }
    const ec = this.eatChain;
    for (let s = 0; s < 81; s++) {
      const c = b[s];
      if (c === 0 || c === STONE) continue;
      const st = STEPS[c] ? STEPS[c][s] : null;
      if (st) {
        for (let i = 0; i < st.length; i++) {
          const t = st[i], tc = b[t];
          if (tc !== 0 && (tc !== STONE || (!ec && !this.edible(t)))) continue;
          if (mode === 2 && !targets[t]) continue;
          n = this._add(buf, n, s, t, c, mode);
        }
      }
      const sl = SLIDES[c];
      for (let k = 0; k < sl.length; k++) {
        const ray = RAYS[sl[k]][s];
        for (let i = 0; i < ray.length; i++) {
          const t = ray[i], tc = b[t];
          if (tc !== 0 && tc !== STONE) break;
          if (tc === STONE && !ec && !this.edible(t)) break;
          if (mode !== 2 || targets[t]) n = this._add(buf, n, s, t, c, mode);
          if (tc === STONE) break;
        }
      }
    }
    return n - off;
  }
  _add(buf, n, from, to, c, mode) {
    const m = from | (to << 7);
    if (PROMOTABLE[c] && (ROW[from] <= 2 || ROW[to] <= 2)) {
      buf[n++] = m | (1 << 14);
      const r = ROW[to];
      if ((c === P || c === L) && r === 0) return n;
      if (c === N && r <= 1) return n;
      if (mode !== 1 && (c === P || c === R || c === B)) return n;
    }
    buf[n++] = m;
    return n;
  }

  // 合法手（自殺手を除く）。囲碁側が2つ目以降を置けないときは END_TURN だけ
  legalMoves() {
    const buf = new Int32Array(1024);
    const n = this.gen(buf, 0, 1);
    const out = [];
    for (let i = 0; i < n; i++) {
      const r = this.make(buf[i]);
      if (r >= 0) { this.unmake(); out.push(buf[i]); }
    }
    if (!out.length && this.side === GO && this.left < this.perTurn) out.push(END_TURN);
    return out;
  }

  // 玉の連の呼吸点（玉が無ければ -1）
  kingLiberties() { return this.kingSq < 0 ? -1 : this.libertyCount(this.kingSq); }

  // 地を数える（囲碁の数え方）: 自分の石・駒 ＋ 自分だけに囲まれた空き升
  area() {
    const b = this.board, seen = new Uint8Array(81);
    let go = 0, shogi = 0;
    for (let s = 0; s < 81; s++) {
      const c = b[s];
      if (c === STONE) { go++; continue; }
      if (c) { shogi++; continue; }
      if (seen[s]) continue;
      // 空き升のかたまりが、石と駒のどちらに接しているか
      const st = [s]; seen[s] = 1;
      let n = 0, tg = false, ts = false;
      while (st.length) {
        const x = st.pop(); n++;
        for (const t of NEI[x]) {
          const tc = b[t];
          if (tc === 0) { if (!seen[t]) { seen[t] = 1; st.push(t); } }
          else if (tc === STONE) tg = true; else ts = true;
        }
      }
      if (tg && !ts) go += n; else if (ts && !tg) shogi += n;
    }
    return { go, shogi };
  }
  // 囲碁側が置けずに終局したときの勝者
  areaWinner() { const a = this.area(); return a.go > a.shogi ? GO : SHOGI; }
}

// ---- AI -----------------------------------------------------------------
// 評価値は将棋側から見た値（センチ歩くらいの単位）
const VAL = new Int32Array(32);
VAL[P] = 100; VAL[L] = 280; VAL[N] = 300; VAL[S] = 420; VAL[G] = 460; VAL[B] = 700; VAL[R] = 820;
VAL[P + PROM] = 460; VAL[L + PROM] = 440; VAL[N + PROM] = 440; VAL[S + PROM] = 460; VAL[B + PROM] = 950; VAL[R + PROM] = 1100;

const PARAMS = {
  cap: 120,                     // 取った石1つ
  near: [0, 9000, 1200, 520, 240, 110, 40],  // あと k 個で勝ちのときの上乗せ
  nearTake: [0, 9000, 1200, 520, 240, 110, 40], // 囲碁側があと k 枚で勝ちのとき
  lostV: 0,                     // 取られた駒1枚（駒の価値とは別に）
  gl: [0, 0, 0, 0],             // 呼吸点が 1,2,3 の石の連（石1つあたり、将棋側の得点）
  race: 50,                     // 碁笥が尽きるまでの手番数 − 将棋側があと取る石の数 − raceOff
  raceOff: 10,
  kl: [0, 1600, 560, 230, 95, 35, 10],      // 玉の連の呼吸点が少ないときの減点（囲碁側が1手番で詰められる数を引いた値で引く）
  mob: 3,                       // 駒の動ける升の数
  eat: 16,                      // 取れる位置にある石
  solid: 0,                     // 取られない位置にある石（囲碁側の得点）。遠くの安全な石を好んでしまうので使わない
  space: 6,                     // 玉から石を通らずに行ける空き升
  spaceCap: 64,
  kspace: 0,                    // 玉から近い（kdepth 歩以内）空き升
  kdepth: 3,
  pieceLib: 30,                 // 囲碁側の次の手番で取られうる駒の連
  goTempo: 40,                  // 囲碁側の手番で置ける残り石1つあたり
  tempo: 10,
  // AI が持つ側ごとの上書き（自己対局で強くなった値）
  bySide: [{ kspace: 8 }, { gl: [0, 160, 64, 20] }],
};

const INF = 1 << 30, WIN = 10000000;
const BASE = 5600; // 初期局面がだいたい 0 になるように
const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();

class Searcher {
  constructor(pos, ttBits) {
    this.p = pos;
    const bits = ttBits || 20;
    this.ttSize = 1 << bits; this.ttMask = this.ttSize - 1;
    this.ttKey = new Int32Array(this.ttSize);
    this.ttMove = new Int32Array(this.ttSize);
    this.ttScore = new Int32Array(this.ttSize);
    this.ttDepth = new Int8Array(this.ttSize);
    this.ttFlag = new Uint8Array(this.ttSize);
    this.MAXPLY = 64;
    this.moveBuf = new Int32Array(this.MAXPLY * 600);
    this.scoreBuf = new Int32Array(this.MAXPLY * 600);
    this.killers = new Int32Array(this.MAXPLY * 2);
    this.history = new Int32Array(2 * 128 * 81);
    this.params = Object.assign({}, PARAMS);
    this.override = null; // 自己対局の比較用
    this.P = this.params;
    // 解析用
    this.gid = new Int16Array(81);
    this.gLibs = new Int16Array(81); this.gLib1 = new Int8Array(81); this.gSize = new Int16Array(81);
    this.gStone = new Uint8Array(81); this.gVal = new Int32Array(81);
    this.gmark = new Int32Array(81); this.gst = 0;
    this.att = new Uint8Array(81);
    this.tgt = new Uint8Array(81);
    this.stack = new Int8Array(96);
    this.noise = 0; this.noiseAmp = 12; // 自己対局で手をばらけさせる
  }
  setPos(p) { this.p = p; }
  clearTT() { this.ttKey.fill(0); this.ttFlag.fill(0); this.ttMove.fill(0); this.ttDepth.fill(0); this.history.fill(0); }

  // 連ごとの呼吸点などを数える
  analyze() {
    const p = this.p, b = p.board, gid = this.gid, stack = this.stack, mark = this.gmark;
    gid.fill(-1);
    let ng = 0;
    for (let s = 0; s < 81; s++) {
      const c = b[s];
      if (c === 0 || gid[s] >= 0) continue;
      const stone = c === STONE;
      const st = ++this.gst;
      let sp = 0, size = 0, libs = 0, val = 0, lib1 = -1;
      stack[sp++] = s; gid[s] = ng;
      while (sp > 0) {
        const x = stack[--sp];
        size++;
        if (!stone) val += VAL[b[x]];
        const nb = NEI[x];
        for (let i = 0; i < nb.length; i++) {
          const t = nb[i], tc = b[t];
          if (tc === 0) { if (mark[t] !== st) { mark[t] = st; libs++; lib1 = t; } }
          else if ((tc === STONE) === stone && gid[t] < 0) { gid[t] = ng; stack[sp++] = t; }
        }
      }
      this.gLibs[ng] = libs; this.gLib1[ng] = lib1; this.gSize[ng] = size; this.gStone[ng] = stone ? 1 : 0; this.gVal[ng] = val;
      ng++;
    }
    this.ng = ng;
  }

  // 将棋側の利き（att[t] = その升に動ける駒の数）と動ける升の総数
  scan() {
    const p = this.p, b = p.board, att = this.att, ec = p.eatChain;
    att.fill(0);
    let mob = 0;
    for (let s = 0; s < 81; s++) {
      const c = b[s];
      if (c === 0 || c === STONE) continue;
      const st = STEPS[c] ? STEPS[c][s] : null;
      if (st) for (let i = 0; i < st.length; i++) { const t = st[i], tc = b[t]; if (tc === 0 || (tc === STONE && (ec || p.edible(t)))) { att[t]++; mob++; } }
      const sl = SLIDES[c];
      for (let k = 0; k < sl.length; k++) {
        const ray = RAYS[sl[k]][s];
        for (let i = 0; i < ray.length; i++) {
          const t = ray[i], tc = b[t];
          if (tc !== 0 && tc !== STONE) break;
          if (tc === STONE) { if (ec || p.edible(t)) { att[t]++; mob++; } break; }
          att[t]++; mob++;
        }
      }
    }
    return mob;
  }

  // 玉から石を通らずに行ける空き升の数（上限つき）
  space(cap) {
    const p = this.p, b = p.board, ks = p.kingSq;
    if (ks < 0) return 0;
    const st = ++this.gst, mark = this.gmark, q = this.qbuf || (this.qbuf = new Int8Array(81));
    let h = 0, t = 0, n = 0;
    q[t++] = ks; mark[ks] = st;
    while (h < t) {
      const x = q[h++];
      const nb = NEI[x];
      for (let i = 0; i < nb.length; i++) {
        const y = nb[i];
        if (mark[y] === st || b[y] === STONE) continue;
        mark[y] = st; q[t++] = y;
        if (b[y] === 0 && ++n >= cap) return n;
      }
    }
    return n;
  }

  // 玉から石を通らずに depth 歩以内で行ける空き升の数
  nearSpace(depth) {
    const p = this.p, b = p.board, ks = p.kingSq;
    if (ks < 0) return 0;
    const st = ++this.gst, mark = this.gmark, q = this.qbuf || (this.qbuf = new Int8Array(81)), dist = this.dbuf || (this.dbuf = new Int8Array(81));
    let h = 0, t = 0, n = 0;
    q[t++] = ks; mark[ks] = st; dist[ks] = 0;
    while (h < t) {
      const x = q[h++];
      if (dist[x] >= depth) continue;
      const nb = NEI[x];
      for (let i = 0; i < nb.length; i++) {
        const y = nb[i];
        if (mark[y] === st || b[y] === STONE) continue;
        mark[y] = st; q[t++] = y; dist[y] = dist[x] + 1;
        if (b[y] === 0) n++;
      }
    }
    return n;
  }

  // 囲碁側が次に置ける石の数（今が囲碁の手番なら残り、将棋の手番なら次の手番の数）
  goReach() { const p = this.p; return p.side === GO ? p.left : p.perTurn; }

  evaluate() {
    const p = this.p, P = this.P, b = p.board;
    this.analyze();
    const mob = this.scan();
    const att = this.att;
    let e = P.cap * p.caps;
    const left = p.goal - p.caps;
    if (left < P.near.length) e += P.near[left];
    const tl = p.take - p.lost;
    if (tl < P.nearTake.length) e -= P.nearTake[tl];
    e -= P.lostV * p.lost;
    if (p.supply < 999) {
      let d = (p.supply - p.placed) / p.perTurn - left - P.raceOff;
      if (d > 20) d = 20; else if (d < -20) d = -20;
      e += P.race * d;
    }
    const reach = this.goReach();
    let kl = 99;
    const kg = p.kingSq >= 0 ? this.gid[p.kingSq] : -1;
    const gl = P.gl;
    for (let g = 0; g < this.ng; g++) {
      if (this.gStone[g]) { const lb = this.gLibs[g]; if (lb < 4) e += gl[lb] * this.gSize[g]; continue; }
      e += this.gVal[g];
      if (g === kg) kl = this.gLibs[g];
      else if (this.gLibs[g] <= reach) e -= P.pieceLib + (this.gVal[g] >> 2);
    }
    const ki = kl - reach + 1; // 1 なら囲碁側の次の手番で玉が取られうる
    if (ki < P.kl.length) e -= P.kl[ki < 0 ? 0 : ki];
    let eat = 0, solid = 0;
    for (let s = 0; s < 81; s++) {
      if (b[s] !== STONE) continue;
      if (att[s]) eat++; else solid++;
    }
    e += P.eat * eat - P.solid * solid + P.mob * mob;
    e += P.space * this.space(P.spaceCap) - BASE;
    if (P.kspace) e += P.kspace * this.nearSpace(P.kdepth);
    if (p.side === GO) e -= P.goTempo * p.left;
    if (this.noise) e += ((Math.imul(p.h1 ^ this.noise, 0x9e3779b1) >>> 24) % (2 * this.noiseAmp + 1)) - this.noiseAmp;
    return (p.side === SHOGI ? e : -e) + P.tempo;
  }

  ttProbe() {
    const i = this.p.h1 & this.ttMask;
    return this.ttKey[i] === this.p.h2 && this.ttFlag[i] ? i : -1;
  }
  ttStore(depth, flag, score, move, ply) {
    const i = this.p.h1 & this.ttMask;
    if (this.ttKey[i] === this.p.h2 && this.ttDepth[i] > depth && this.ttFlag[i]) return;
    if (score > WIN - 1000) score += ply; else if (score < -WIN + 1000) score -= ply;
    this.ttKey[i] = this.p.h2; this.ttDepth[i] = depth; this.ttFlag[i] = flag; this.ttScore[i] = score; this.ttMove[i] = move;
  }

  timeUp() {
    if ((++this.nodes & 1023) === 0 && now() > this.deadline) this.stop = true;
    return this.stop;
  }

  histIdx(m) { return ((this.p.side * 128 + (m & 127)) * 81) + ((m >> 7) & 127); }

  // 手の並べ替え。analyze() 済みの局面で呼ぶ
  orderMoves(off, n, ttMove, ply) {
    const p = this.p, mb = this.moveBuf, sb = this.scoreBuf, b = p.board, gid = this.gid;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    const goSide = p.side === GO;
    const kg = p.kingSq >= 0 ? gid[p.kingSq] : -1;
    const reach = goSide ? p.left : 0;
    for (let i = off; i < off + n; i++) {
      const m = mb[i];
      if (m === ttMove) { sb[i] = 1 << 29; continue; }
      const to = (m >> 7) & 127;
      let s = 0;
      if (goSide) {
        // 囲碁: 駒の連の呼吸点を詰める手（取る・アタリ）、玉の連に迫る手
        const nb = NEI[to];
        let tact = 0;
        for (let j = 0; j < nb.length; j++) {
          const t = nb[j], c = b[t];
          if (c === 0 || c === STONE) continue;
          const g = gid[t], lb = this.gLibs[g];
          if (lb <= reach) tact += (g === kg ? 1 << 24 : (1 << 22) + this.gVal[g] * (lb === 1 ? 4 : 1));
          else if (lb === reach + 1) tact += (g === kg ? 1 << 21 : (1 << 19) + (this.gVal[g] >> 1));
          else if (g === kg) tact += 4000 + (8 - lb) * 500;
          else tact += 300;
        }
        s = tact ? (1 << 20) + tact : 0;
      } else {
        const from = m & 127, tgt = b[to];
        if (tgt === STONE) s = (1 << 24) - VAL[b[from]] + (this.gLibs[gid[to]] === 1 ? 2000 : 0);
        else {
          // 石の連の最後の呼吸点に動く手（囲んで取る）
          const nb = NEI[to];
          for (let j = 0; j < nb.length; j++) {
            const t = nb[j];
            if (b[t] === STONE && this.gLibs[gid[t]] === 1) { s = (1 << 23) + this.gSize[gid[t]] * 100; break; }
          }
          // 次の囲碁の手番で取られうる連から逃げる手
          if (!s && this.gLibs[gid[from]] <= p.perTurn) s = (1 << 21) + VAL[b[from]] + (gid[from] === kg ? 1 << 22 : 0);
        }
        if ((m >> 14) & 1) s += 3000;
      }
      if (s < (1 << 20)) {
        if (m === k1) s = (1 << 20) - 2;
        else if (m === k2) s = (1 << 20) - 3;
        else s += this.history[this.histIdx(m)] >> 4;
      }
      sb[i] = s;
    }
  }
  pick(i, end) {
    const mb = this.moveBuf, sb = this.scoreBuf;
    let bi = i, bs = sb[i];
    for (let j = i + 1; j < end; j++) if (sb[j] > bs) { bs = sb[j]; bi = j; }
    if (bi !== i) {
      const tm = mb[i]; mb[i] = mb[bi]; mb[bi] = tm;
      const ts = sb[i]; sb[i] = sb[bi]; sb[bi] = ts;
    }
    return mb[i];
  }

  // 子局面の値（同じ側が続けて指すときは符号を変えない）
  child(depth, alpha, beta, ply, side, q, qd) {
    if (this.p.side === side) return q ? this.qsearch(alpha, beta, ply, qd) : this.search(depth, alpha, beta, ply);
    return -(q ? this.qsearch(-beta, -alpha, ply, qd) : this.search(depth, -beta, -alpha, ply));
  }

  // 静止探索: 取る手（と、玉の危機への対応）だけを読む
  qsearch(alpha, beta, ply, qd) {
    const p = this.p;
    if (this.timeUp()) return 0;
    const stand = this.evaluate(); // analyze() も済む
    const side = p.side;
    const kg = p.kingSq >= 0 ? this.gid[p.kingSq] : -1;
    const kl = kg >= 0 ? this.gLibs[kg] : 0;
    const evade = side === SHOGI && kl <= p.perTurn && qd < 5;
    let best = -INF;
    if (!evade) {
      if (stand >= beta || qd >= 8 || ply >= this.MAXPLY - 2) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
    }
    const tg = this.tgt, b = p.board;
    let any = false;
    if (side === GO) {
      tg.fill(0);
      const reach = p.left;
      for (let g = 0; g < this.ng; g++) {
        if (this.gStone[g]) continue;
        const lb = this.gLibs[g];
        if (lb <= reach || (g === kg && lb <= reach + 1 && qd < 3)) {
          if (lb === 1) tg[this.gLib1[g]] = 1;
          else for (let s = 0; s < 81; s++) if (b[s] === 0 && this.adjGroup(s, g)) tg[s] = 1;
          any = true;
        }
      }
    } else if (!evade) {
      tg.fill(0);
      for (let s = 0; s < 81; s++) if (b[s] === STONE) { tg[s] = 1; any = true; }
      for (let g = 0; g < this.ng; g++) if (this.gStone[g] && this.gLibs[g] === 1) { tg[this.gLib1[g]] = 1; any = true; }
    }
    if (!any && !evade) return best;
    const off = ply * 600;
    const n = p.gen(this.moveBuf, off, evade ? 0 : 2, tg);
    this.orderMoves(off, n, 0, ply);
    let legal = 0;
    for (let i = off; i < off + n; i++) {
      const m = this.pick(i, off + n);
      const r = p.make(m);
      if (r < 0) continue;
      legal++;
      if (r === 1) { p.unmake(); return WIN - ply - 1; }
      if (r === 2) { p.unmake(); if (-WIN + ply + 1 > best) best = -WIN + ply + 1; continue; }
      const v = this.child(0, alpha, beta, ply + 1, side, true, qd + 1);
      p.unmake();
      if (this.stop) return 0;
      if (v > best) {
        best = v;
        if (v > alpha) { alpha = v; if (v >= beta) break; }
      }
    }
    if (evade && legal === 0) return -WIN + ply + 2;
    return best;
  }

  adjGroup(s, g) {
    const nb = NEI[s];
    for (let i = 0; i < nb.length; i++) if (this.gid[nb[i]] === g) return true;
    return false;
  }

  search(depth, alpha, beta, ply) {
    const p = this.p;
    if (this.timeUp()) return 0;
    if (depth <= 0 || ply >= this.MAXPLY - 4) return this.qsearch(alpha, beta, ply, 0);
    const side = p.side;

    const pv = beta - alpha > 1;
    let ttMove = 0;
    const ti = this.ttProbe();
    if (ti >= 0) {
      ttMove = this.ttMove[ti];
      if (!pv && ply > 0 && this.ttDepth[ti] >= depth) {
        let sc = this.ttScore[ti];
        if (sc > WIN - 1000) sc -= ply; else if (sc < -WIN + 1000) sc += ply;
        const fl = this.ttFlag[ti];
        if (fl === 1 || (fl === 2 && sc >= beta) || (fl === 3 && sc <= alpha)) return sc;
      }
    }
    this.analyze();
    const kg = p.kingSq >= 0 ? this.gid[p.kingSq] : -1;
    const kl = kg >= 0 ? this.gLibs[kg] : 0;
    // 玉の連が次の囲碁の手番で取られうるなら延長
    if (side === SHOGI && kl <= p.perTurn && ply < this.rootDepth * 2) depth++;

    const off = ply * 600;
    const n = p.gen(this.moveBuf, off, 0);
    this.orderMoves(off, n, ttMove, ply);

    const alpha0 = alpha;
    let best = -INF, bestMove = 0, searched = 0;
    for (let i = off; i < off + n; i++) {
      const m = this.pick(i, off + n);
      const sc = this.scoreBuf[i];
      const r = p.make(m);
      if (r < 0) continue;
      if (r === 1) {
        p.unmake();
        best = WIN - ply - 1; bestMove = m;
        break;
      }
      if (r === 2) {
        p.unmake();
        searched++;
        if (-WIN + ply + 1 > best) { best = -WIN + ply + 1; bestMove = m; }
        continue;
      }
      const tactical = sc >= (1 << 20);
      let v;
      if (searched === 0) {
        v = this.child(depth - 1, alpha, beta, ply + 1, side);
      } else {
        let red = 0;
        if (depth >= 3 && searched >= 3 && !tactical) {
          red = 1 + (searched >= 8 ? 1 : 0) + (depth >= 6 && searched >= 16 ? 1 : 0);
          if (red > depth - 2) red = depth - 2;
        }
        v = this.child(depth - 1 - red, alpha, alpha + 1, ply + 1, side);
        if (!this.stop && v > alpha && red > 0) v = this.child(depth - 1, alpha, alpha + 1, ply + 1, side);
        if (!this.stop && v > alpha && v < beta) v = this.child(depth - 1, alpha, beta, ply + 1, side);
      }
      p.unmake();
      if (this.stop) return 0;
      searched++;
      if (ply === 0 && (v > best || searched === 1)) { this.rootBest = m; this.rootScore = v; }
      if (v > best) {
        best = v; bestMove = m;
        if (v > alpha) {
          alpha = v;
          if (v >= beta) {
            if (!tactical) {
              const kb = ply * 2;
              if (this.killers[kb] !== m) { this.killers[kb + 1] = this.killers[kb]; this.killers[kb] = m; }
              const hi = this.histIdx(m);
              this.history[hi] += depth * depth * 16;
              if (this.history[hi] > 1 << 22) for (let k = 0; k < this.history.length; k++) this.history[k] >>= 1;
            }
            break;
          }
        }
      }
    }
    if (searched === 0 && best === -INF) {
      // 指せる手が無い: 囲碁側の2つ目以降なら手番を終える。囲碁側の手番の初めなら地を数えて終局。将棋側は負け
      if (side === GO && p.left < p.perTurn) {
        p.make(END_TURN);
        const v = -this.search(depth - 1, -beta, -alpha, ply + 1);
        p.unmake();
        return v;
      }
      if (side === GO && p.areaWinner() === GO) return WIN - ply;
      return -WIN + ply;
    }
    const flag = best >= beta ? 2 : best > alpha0 ? 1 : 3;
    this.ttStore(depth, flag, best, bestMove, ply);
    return best;
  }

  // 思考。timeMs ミリ秒で反復深化
  think(timeMs, maxDepth, onInfo) {
    const p = this.p;
    this.nodes = 0; this.stop = false;
    this.P = Object.assign({}, this.params, (this.params.bySide || [])[p.side] || {}, this.override || {});
    const start = now();
    this.deadline = start + timeMs;
    this.killers.fill(0);
    for (let k = 0; k < this.history.length; k++) this.history[k] >>= 2;
    const legal = p.legalMoves();
    if (legal.length === 0) return { move: 0, score: p.side === GO && p.areaWinner() === GO ? WIN : -WIN, depth: 0, nodes: 0 };
    for (const m of legal) {
      if (p.make(m) === 1) { p.unmake(); return { move: m, score: WIN, depth: 1, nodes: 1 }; }
      p.unmake();
    }
    if (legal.length === 1) return { move: legal[0], score: 0, depth: 0, nodes: 1 };
    let bestMove = legal[0], bestScore = 0, done = 0;
    maxDepth = maxDepth || 40;
    for (let d = 1; d <= maxDepth; d++) {
      this.rootDepth = d;
      this.rootBest = 0;
      let v;
      if (d >= 3 && Math.abs(bestScore) < WIN - 1000) {
        const a = bestScore - 150, bb = bestScore + 150;
        v = this.search(d, a, bb, 0);
        if (!this.stop && (v <= a || v >= bb)) v = this.search(d, -INF, INF, 0);
      } else {
        v = this.search(d, -INF, INF, 0);
      }
      if (this.stop) {
        if (this.rootBest && this.rootScore > bestScore) { bestMove = this.rootBest; bestScore = this.rootScore; }
        break;
      }
      const ti = this.ttProbe();
      bestMove = ti >= 0 && this.ttMove[ti] && legal.includes(this.ttMove[ti]) ? this.ttMove[ti] : (this.rootBest || bestMove);
      bestScore = v; done = d;
      if (onInfo) onInfo({ depth: d, score: v, nodes: this.nodes, time: now() - start });
      if (Math.abs(v) >= WIN - 1000) break;
      if (now() - start > timeMs * 0.5) break;
    }
    return { move: bestMove, score: bestScore, depth: done, nodes: this.nodes, time: now() - start };
  }
}

const SG = {
  Pos, Searcher, decode, goMove, PARAMS, VAL, WIN, HANDICAPS, STAR, DEFAULT_RULES, END_TURN,
  EMPTY, K, R, B, G, S, N, L, P, PROM, STONE, SHOGI, GO, GO_FROM, ROW, COL, NEI, PROMOTABLE,
};
if (typeof module !== 'undefined' && module.exports) module.exports = SG;
else root.SG = SG;
})(typeof self !== 'undefined' ? self : this);
