// 量子将棋エンジン（ルール判定＋AI探索）
// ブラウザ（メインスレッド / Web Worker）と Node.js の両方で動く単一ファイル。
(function (root) {
'use strict';

// ---- 駒種 -------------------------------------------------------------
// 0:玉 1:飛 2:角 3:金 4:銀 5:桂 6:香 7:歩
const BK = 1, BR = 2, BB = 4, BG = 8, BS = 16, BN = 32, BL = 64, BP = 128;
const ALL = 255;
const PROMOTABLE = BR | BB | BS | BN | BL | BP;
const GOLDISH = BS | BN | BL | BP; // 成ると金の動きになる駒
const CAP = [1, 1, 1, 2, 2, 2, 2, 9]; // 1陣営あたりの枚数
const CAPT = new Int8Array(256);
for (let T = 0; T < 256; T++) {
  let c = 0;
  for (let t = 0; t < 8; t++) if (T >> t & 1) c += CAP[t];
  CAPT[T] = c;
}
const POPCNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let c = 0; for (let t = 0; t < 8; t++) if (i >> t & 1) c++; POPCNT[i] = c; }

// ---- 盤の幾何 ---------------------------------------------------------
// sq = row*9 + col。row 0 が上（後手陣の一段目）、col 0 が左（9筋）。
// 先手(0)は上へ、後手(1)は下へ進む。
const ROW = new Int8Array(81), COL = new Int8Array(81);
for (let s = 0; s < 81; s++) { ROW[s] = (s / 9) | 0; COL[s] = s % 9; }
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
// 先手視点の一歩の動き
const STEP_DEFS = [
  [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]], // 0 玉
  [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]],                  // 1 金
  [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]],                          // 2 銀
  [[-2, -1], [-2, 1]],                                                    // 3 桂
  [[-1, 0]],                                                              // 4 歩
  [[-1, 0], [1, 0], [0, -1], [0, 1]],                                     // 5 縦横1
  [[-1, -1], [-1, 1], [1, -1], [1, 1]],                                   // 6 斜め1
];
const STEPS = [[], []];
for (let side = 0; side < 2; side++) {
  for (let k = 0; k < STEP_DEFS.length; k++) {
    const arr = [];
    for (let s = 0; s < 81; s++) {
      const r = [];
      for (const [dr, dc] of STEP_DEFS[k]) {
        const y = ROW[s] + (side === 0 ? dr : -dr), x = COL[s] + dc;
        if (y >= 0 && y < 9 && x >= 0 && x < 9) r.push(y * 9 + x);
      }
      arr.push(Int8Array.from(r));
    }
    STEPS[side].push(arr);
  }
}
// 到達判定用テーブル
const STEP_BITS = [new Uint8Array(6561), new Uint8Array(6561)]; // 未成の一歩で届く駒種
const GOLD_REACH = [new Uint8Array(6561), new Uint8Array(6561)];
const ORTH1 = new Uint8Array(6561), DIAG1 = new Uint8Array(6561);
const LINE = new Int8Array(6561); // 同一直線なら 方向+1
const STEP_TYPE_BITS = [BK, BG, BS, BN, BP];
for (let side = 0; side < 2; side++) {
  for (let s = 0; s < 81; s++) {
    for (let k = 0; k < 5; k++) for (const t of STEPS[side][k][s]) STEP_BITS[side][s * 81 + t] |= STEP_TYPE_BITS[k];
    for (const t of STEPS[side][1][s]) GOLD_REACH[side][s * 81 + t] = 1;
  }
}
for (let s = 0; s < 81; s++) {
  for (const t of STEPS[0][5][s]) ORTH1[s * 81 + t] = 1;
  for (const t of STEPS[0][6][s]) DIAG1[s * 81 + t] = 1;
  for (let d = 0; d < 8; d++) for (const t of RAYS[d][s]) LINE[s * 81 + t] = d + 1;
}

// ---- Zobrist ----------------------------------------------------------
let seed = 0x9e3779b9 | 0;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; }
const ZP1 = new Int32Array(40 * 328), ZP2 = new Int32Array(40 * 328);
const ZM1 = new Int32Array(40 * 256), ZM2 = new Int32Array(40 * 256);
for (let i = 0; i < ZP1.length; i++) { ZP1[i] = rnd(); ZP2[i] = rnd(); }
for (let i = 0; i < ZM1.length; i++) { ZM1[i] = rnd(); ZM2[i] = rnd(); }
const ZS1 = rnd(), ZS2 = rnd();

// ---- 局面 -------------------------------------------------------------
// 駒 id 0..19 は先手の初期駒（先手陣営）、20..39 は後手陣営。
// 陣営ごとに「玉1飛1角1金2銀2桂2香2歩9」と矛盾しない割り当てが存在しなければならない。
// 割り当ての存在は Hall の定理で判定する: 全ての駒種集合 T について
//   (可能性が T に含まれる駒の数) <= (T の駒種の総枚数)
const MAXUNDO = 4096;
const PC_SIZE = 1 << 14, PC_MASK = PC_SIZE - 1;
class Pos {
  constructor() {
    this.pos = new Int8Array(40);   // 盤上の升 or -1（持ち駒）
    this.owner = new Uint8Array(40);
    this.prom = new Uint8Array(40);
    this.mask = new Uint8Array(40); // 可能な駒種
    this.board = new Int8Array(81);
    this.hist = [new Int16Array(256), new Int16Array(256)];
    this.f = new Int16Array(256);
    this.tightBuf = new Uint8Array(256);
    this.exCache = new Int16Array(256);
    this.pruned = new Uint8Array(40);
    this.dm = new Uint8Array(81);
    this.tl = new Int8Array(81);
    this.tc = 0;
    this.seen = new Uint8Array(256);
    this.att = [new Uint8Array(81), new Uint8Array(81)];
    this.side = 0;
    this.h1 = 0; this.h2 = 0;
    this.pcKey = new Int32Array(PC_SIZE); this.pcK1 = new Int32Array(PC_SIZE);
    this.pcOk = new Uint8Array(PC_SIZE); this.pcVal = new Uint8Array(PC_SIZE * 20);
    this.pcK1.fill(-1);
    this.u = new Int32Array(MAXUNDO * 10);
    this.usp = 0;
    this.hs1 = new Int32Array(MAXUNDO + 1024);
    this.hs2 = new Int32Array(MAXUNDO + 1024);
    this.hsp = 0;
    this.initial();
  }

  initial() {
    this.board.fill(-1);
    this.hist[0].fill(0); this.hist[1].fill(0);
    let id = 0;
    const place = (sq, side) => {
      this.pos[id] = sq; this.owner[id] = side; this.prom[id] = 0; this.mask[id] = ALL;
      this.board[sq] = id; this.hist[side][ALL]++; id++;
    };
    for (let c = 0; c < 9; c++) place(72 + c, 0);
    place(63 + 1, 0); place(63 + 7, 0);
    for (let c = 0; c < 9; c++) place(54 + c, 0);
    for (let c = 0; c < 9; c++) place(c, 1);
    place(9 + 7, 1); place(9 + 1, 1);
    for (let c = 0; c < 9; c++) place(18 + c, 1);
    this.side = 0;
    this.usp = 0; this.hsp = 0;
    this.rehash();
  }

  rehash() {
    let h1 = 0, h2 = 0;
    for (let id = 0; id < 40; id++) {
      const k = id * 328 + (this.pos[id] + 1) * 4 + this.owner[id] * 2 + this.prom[id];
      h1 ^= ZP1[k] ^ ZM1[id * 256 + this.mask[id]];
      h2 ^= ZP2[k] ^ ZM2[id * 256 + this.mask[id]];
    }
    if (this.side) { h1 ^= ZS1; h2 ^= ZS2; }
    this.h1 = h1; this.h2 = h2;
  }

  rebuildHist() {
    this.hist[0].fill(0); this.hist[1].fill(0);
    for (let id = 0; id < 40; id++) this.hist[id < 20 ? 0 : 1][this.mask[id]]++;
  }

  xorPiece(id) {
    const k = id * 328 + (this.pos[id] + 1) * 4 + this.owner[id] * 2 + this.prom[id];
    this.h1 ^= ZP1[k] ^ ZM1[id * 256 + this.mask[id]];
    this.h2 ^= ZP2[k] ^ ZM2[id * 256 + this.mask[id]];
  }

  // 陣営 a の各駒について、実際にありうる駒種へ絞った pruned を計算。矛盾があれば false。
  pruneArmy(a) {
    // 結果は陣営の可能性集合だけで決まるのでキャッシュする
    const lo = a * 20, mask = this.mask, pr = this.pruned;
    let k1 = a, k2 = 0;
    for (let id = lo; id < lo + 20; id++) { k1 ^= ZM1[id * 256 + mask[id]]; k2 ^= ZM2[id * 256 + mask[id]]; }
    const ci = (k1 & PC_MASK), cb = ci * 20;
    if (this.pcKey[ci] === k2 && this.pcK1[ci] === k1) {
      if (!this.pcOk[ci]) return false;
      for (let i = 0; i < 20; i++) pr[lo + i] = this.pcVal[cb + i];
      return true;
    }
    const ok = this._pruneArmy(a);
    this.pcKey[ci] = k2; this.pcK1[ci] = k1; this.pcOk[ci] = ok ? 1 : 0;
    if (ok) for (let i = 0; i < 20; i++) this.pcVal[cb + i] = pr[lo + i];
    return ok;
  }

  _pruneArmy(a) {
    const f = this.f, tl = this.tightBuf, ex = this.exCache;
    f.set(this.hist[a]);
    for (let b = 1; b < 256; b <<= 1) {
      for (let base = 0; base < 256; base += b << 1) {
        for (let j = base + b, e = base + (b << 1); j < e; j++) f[j] += f[j - b];
      }
    }
    let n = 0;
    for (let T = 1; T < 255; T++) {
      const d = CAPT[T] - f[T];
      if (d < 0) return false;
      if (d === 0) tl[n++] = T;
    }
    if (f[255] !== 20) return false;
    ex.fill(-1);
    const lo = a * 20, hi = lo + 20, mask = this.mask, pr = this.pruned;
    for (let id = lo; id < hi; id++) {
      const m = mask[id];
      let e = ex[m];
      if (e < 0) {
        e = 0;
        for (let i = 0; i < n; i++) { const T = tl[i]; if (m & ~T) e |= T; }
        ex[m] = e;
      }
      pr[id] = m & ~e;
    }
    return true;
  }

  prune() {
    const a = this.pruneArmy(0);
    const b = this.pruneArmy(1);
    return a && b;
  }

  // 可能性を pruned に確定させる（実際の対局で1手ごとに呼ぶ）
  normalize() {
    this.prune();
    for (let id = 0; id < 40; id++) this.mask[id] = this.pruned[id];
    this.rebuildHist();
    this.rehash();
  }

  // 駒 id の利き（味方の駒がいる升も含む）を this.tl[0..tc) と this.dm に積む。呼び出し側が dm を0に戻す。
  _steps(list, bits) {
    const dm = this.dm, tl = this.tl;
    for (let i = 0; i < list.length; i++) {
      const to = list[i];
      if (dm[to] === 0) tl[this.tc++] = to;
      dm[to] |= bits;
    }
  }
  _ray(d, from, bits) {
    const r = RAYS[d][from], b = this.board, dm = this.dm, tl = this.tl;
    for (let i = 0; i < r.length; i++) {
      const to = r[i];
      if (dm[to] === 0) tl[this.tc++] = to;
      dm[to] |= bits;
      if (b[to] >= 0) break;
    }
  }
  targets(id) {
    this.tc = 0;
    const s = this.owner[id], from = this.pos[id], pm = this.pruned[id];
    const ST = STEPS[s];
    if (!this.prom[id]) {
      if (pm & BK) this._steps(ST[0][from], BK);
      if (pm & BG) this._steps(ST[1][from], BG);
      if (pm & BS) this._steps(ST[2][from], BS);
      if (pm & BN) this._steps(ST[3][from], BN);
      if (pm & BP) this._steps(ST[4][from], BP);
      if (pm & BL) this._ray(s === 0 ? 0 : 1, from, BL);
      if (pm & BR) { this._ray(0, from, BR); this._ray(1, from, BR); this._ray(2, from, BR); this._ray(3, from, BR); }
      if (pm & BB) { this._ray(4, from, BB); this._ray(5, from, BB); this._ray(6, from, BB); this._ray(7, from, BB); }
    } else {
      const g = pm & GOLDISH;
      if (g) this._steps(ST[1][from], g);
      if (pm & BR) {
        this._ray(0, from, BR); this._ray(1, from, BR); this._ray(2, from, BR); this._ray(3, from, BR);
        this._steps(ST[6][from], BR);
      }
      if (pm & BB) {
        this._ray(4, from, BB); this._ray(5, from, BB); this._ray(6, from, BB); this._ray(7, from, BB);
        this._steps(ST[5][from], BB);
      }
    }
    return this.tc;
  }

  // 駒 id が升 to に動けるか（pruned 前提）
  canReach(id, to) {
    const from = this.pos[id];
    if (from < 0) return false;
    const s = this.owner[id], pm = this.pruned[id], idx = from * 81 + to;
    if (!this.prom[id]) {
      if (STEP_BITS[s][idx] & pm) return true;
      const d = LINE[idx] - 1;
      if (d < 0) return false;
      if (!((d < 4 && (pm & BR)) || (d >= 4 && (pm & BB)) || ((pm & BL) && d === (s === 0 ? 0 : 1)))) return false;
      return this._clear(d, from, to);
    } else {
      if ((pm & GOLDISH) && GOLD_REACH[s][idx]) return true;
      if (pm & BR) {
        if (DIAG1[idx]) return true;
        const d = LINE[idx] - 1;
        if (d >= 0 && d < 4 && this._clear(d, from, to)) return true;
      }
      if (pm & BB) {
        if (ORTH1[idx]) return true;
        const d = LINE[idx] - 1;
        if (d >= 4 && this._clear(d, from, to)) return true;
      }
      return false;
    }
  }
  _clear(d, from, to) {
    const r = RAYS[d][from], b = this.board;
    for (let i = 0; i < r.length; i++) {
      const s = r[i];
      if (s === to) return true;
      if (b[s] >= 0) return false;
    }
    return false;
  }
  attackedBy(sq, side) {
    for (let id = 0; id < 40; id++) {
      if (this.owner[id] === side && this.pos[id] >= 0 && this.canReach(id, sq)) return true;
    }
    return false;
  }
  // 玉で確定している side の駒（なければ -1）
  kingOnly(side) {
    const lo = side * 20;
    for (let id = lo; id < lo + 20; id++) {
      if (this.pruned[id] === BK && this.pos[id] >= 0) return id;
    }
    return -1;
  }

  // 合法手生成（prune() 済み前提）。手は整数: id | to<<6 | 成り<<13 | 新しい可能性<<14
  gen(out, off, capOnly) {
    const s = this.side, board = this.board, pos = this.pos, owner = this.owner, pr = this.pruned, dm = this.dm, tl = this.tl;
    let n = off;
    for (let id = 0; id < 40; id++) {
      if (owner[id] !== s) continue;
      const from = pos[id];
      if (from < 0) continue;
      const tc = this.targets(id);
      const isP = this.prom[id];
      const relFrom = s === 0 ? ROW[from] : 8 - ROW[from];
      for (let i = 0; i < tc; i++) {
        const to = tl[i], M = dm[to];
        dm[to] = 0;
        const q = board[to];
        if (q >= 0 ? owner[q] === s : capOnly) continue;
        const base = id | to << 6;
        if (isP) { out[n++] = base | M << 14; continue; }
        const rel = s === 0 ? ROW[to] : 8 - ROW[to];
        let Mn = M;
        if (rel === 0) Mn &= ~(BP | BL | BN); else if (rel === 1) Mn &= ~BN;
        if (Mn) out[n++] = base | Mn << 14;
        if (rel <= 2 || relFrom <= 2) {
          const Mp = M & PROMOTABLE;
          if (Mp) out[n++] = base | 1 << 13 | Mp << 14;
        }
      }
    }
    if (!capOnly) {
      const seen = this.seen;
      let pawnFiles = 0, any = false;
      for (let id = 0; id < 40; id++) {
        if (owner[id] !== s) continue;
        if (pos[id] < 0) { any = true; continue; }
        if (!this.prom[id] && pr[id] === BP) pawnFiles |= 1 << COL[pos[id]];
      }
      if (any) {
        seen.fill(0);
        for (let id = 0; id < 40; id++) {
          if (owner[id] !== s || pos[id] >= 0) continue;
          const m = pr[id];
          if (seen[m]) continue;
          seen[m] = 1;
          for (let sq = 0; sq < 81; sq++) {
            if (board[sq] >= 0) continue;
            const rel = s === 0 ? ROW[sq] : 8 - ROW[sq];
            let M = m;
            if (rel === 0) M &= ~(BP | BL | BN); else if (rel === 1) M &= ~BN;
            if (pawnFiles >> COL[sq] & 1) M &= ~BP;
            if (M) out[n++] = id | sq << 6 | M << 14;
          }
        }
      }
    }
    return n - off;
  }

  // 指す。戻り値 1 = 指した側の勝ち（相手陣営に玉がありえなくなった）
  make(m) {
    const id = m & 63, to = (m >> 6) & 127, pf = (m >> 13) & 1, nm = (m >> 14) & 255;
    const s = this.side, u = this.u, b = this.usp * 10;
    const from = this.pos[id], q = this.board[to];
    u[b] = m; u[b + 1] = from; u[b + 2] = this.prom[id]; u[b + 3] = this.mask[id]; u[b + 4] = q;
    u[b + 8] = this.h1; u[b + 9] = this.h2;
    this.usp++;
    let win = 0;
    if (q >= 0) {
      u[b + 5] = this.owner[q]; u[b + 6] = this.prom[q]; u[b + 7] = this.mask[q];
      const aq = q < 20 ? 0 : 1;
      this.xorPiece(q);
      this.hist[aq][this.mask[q]]--;
      this.owner[q] = s; this.pos[q] = -1; this.prom[q] = 0; this.mask[q] &= ~BK;
      this.hist[aq][this.mask[q]]++;
      this.xorPiece(q);
    }
    this.xorPiece(id);
    const ai = id < 20 ? 0 : 1;
    this.hist[ai][this.mask[id]]--;
    this.hist[ai][nm]++;
    if (from >= 0) this.board[from] = -1;
    this.pos[id] = to; this.board[to] = id;
    if (pf) this.prom[id] = 1;
    this.mask[id] = nm;
    this.xorPiece(id);
    this.side = s ^ 1;
    this.h1 ^= ZS1; this.h2 ^= ZS2;
    this.hs1[this.hsp] = this.h1; this.hs2[this.hsp] = this.h2; this.hsp++;
    if (q >= 0 && !this.pruneArmy(q < 20 ? 0 : 1)) win = 1;
    return win;
  }

  unmake() {
    this.usp--;
    this.hsp--;
    const u = this.u, b = this.usp * 10;
    const m = u[b], id = m & 63, to = (m >> 6) & 127;
    const from = u[b + 1], q = u[b + 4];
    const ai = id < 20 ? 0 : 1;
    this.hist[ai][this.mask[id]]--;
    this.hist[ai][u[b + 3]]++;
    this.pos[id] = from; this.prom[id] = u[b + 2]; this.mask[id] = u[b + 3];
    if (from >= 0) this.board[from] = id;
    this.board[to] = q;
    if (q >= 0) {
      const aq = q < 20 ? 0 : 1;
      this.hist[aq][this.mask[q]]--;
      this.owner[q] = u[b + 5]; this.prom[q] = u[b + 6]; this.mask[q] = u[b + 7]; this.pos[q] = to;
      this.hist[aq][this.mask[q]]++;
    }
    this.side ^= 1;
    this.h1 = u[b + 8]; this.h2 = u[b + 9];
  }

  makeNull() {
    const b = this.usp * 10;
    this.u[b] = -1; this.u[b + 8] = this.h1; this.u[b + 9] = this.h2;
    this.usp++;
    this.side ^= 1; this.h1 ^= ZS1; this.h2 ^= ZS2;
    this.hs1[this.hsp] = this.h1; this.hs2[this.hsp] = this.h2; this.hsp++;
  }
  unmakeNull() {
    this.usp--; this.hsp--;
    const b = this.usp * 10;
    this.side ^= 1; this.h1 = this.u[b + 8]; this.h2 = this.u[b + 9];
  }

  // 現局面と同じ局面が過去に何回あったか（同じ手番のみ）
  repetitions(limit) {
    let c = 0;
    const h1 = this.h1, h2 = this.h2, end = Math.max(0, this.hsp - 1 - limit);
    for (let i = this.hsp - 3; i >= end; i -= 2) if (this.hs1[i] === h1 && this.hs2[i] === h2) c++;
    return c;
  }

  lastTo() {
    if (this.usp === 0) return -1;
    const m = this.u[(this.usp - 1) * 10];
    return m < 0 ? -1 : (m >> 6) & 127;
  }

  // ---- UI 向けの補助 ----
  legalMoves() {
    this.prune();
    const buf = new Int32Array(8192);
    const n = this.gen(buf, 0, false);
    return Array.from(buf.subarray(0, n));
  }
  clone() {
    const p = new Pos();
    p.load(this.serialize());
    return p;
  }
  serialize() {
    return {
      pos: Array.from(this.pos), owner: Array.from(this.owner), prom: Array.from(this.prom),
      mask: Array.from(this.mask), side: this.side,
    };
  }
  load(o) {
    this.pos.set(o.pos); this.owner.set(o.owner); this.prom.set(o.prom); this.mask.set(o.mask);
    this.side = o.side;
    this.board.fill(-1);
    for (let id = 0; id < 40; id++) if (this.pos[id] >= 0) this.board[this.pos[id]] = id;
    this.usp = 0; this.hsp = 0;
    this.rebuildHist();
    this.rehash();
  }
  pushHistory(h1, h2) { this.hs1[this.hsp] = h1; this.hs2[this.hsp] = h2; this.hsp++; }
}

function decode(m) {
  return { id: m & 63, to: (m >> 6) & 127, prom: (m >> 13) & 1, mask: (m >> 14) & 255 };
}

// ---- 評価 -------------------------------------------------------------
// 駒の価値（歩=100）
const V0 = [0, 1000, 850, 620, 560, 420, 380, 100];   // 未成
const V1 = [0, 1300, 1150, 0, 620, 600, 600, 620];    // 成駒（龍・馬・全・圭・杏・と）
// 平均的な価値（並べ替え・SEE 用）
const QV = [new Int16Array(256), new Int16Array(256)];
for (let pr = 0; pr < 2; pr++) {
  const tb = pr ? V1 : V0;
  for (let m = 0; m < 256; m++) {
    let sum = 0, c = 0;
    for (let t = 1; t < 8; t++) if (m >> t & 1) { sum += tb[t] * CAP[t]; c += CAP[t]; }
    QV[pr][m] = c ? Math.round(sum / c) : 0;
  }
}
const PARAMS = {
  flex: 0.25,      // 重ね合わせの柔軟性ボーナス（最大値との差の割合）
  hand: 1.10,      // 持ち駒の倍率
  mob: 3,          // 利き1升あたり
  kc: [900, 330, 150, 75, 38, 18, 8, 3, 0],                 // 玉候補の数ごとのペナルティ
  kAtt: [0, 0, 160, 75, 38, 20, 10, 6, 4, 2],               // 玉候補が攻撃されているときのペナルティ
  kZone: 28,       // 確定玉の周囲への利き
  tempo: 25,
  advance: 6,      // 確定した歩が進むボーナス
};

class Searcher {
  constructor(pos, ttBits) {
    this.p = pos;
    const bits = ttBits || 19;
    this.ttSize = 1 << bits; this.ttMask = this.ttSize - 1;
    this.ttKey = new Int32Array(this.ttSize);
    this.ttMove = new Int32Array(this.ttSize);
    this.ttScore = new Int32Array(this.ttSize);
    this.ttDepth = new Int8Array(this.ttSize);
    this.ttFlag = new Uint8Array(this.ttSize);
    this.MAXPLY = 64;
    this.moveBuf = new Int32Array(this.MAXPLY * 3000);
    this.scoreBuf = new Int32Array(this.MAXPLY * 3000);
    this.killers = new Int32Array(this.MAXPLY * 2);
    this.history = new Int32Array(40 * 81);
    this.params = Object.assign({}, PARAMS);
    this.vstamp = 0; this.vst = new Int32Array(1024); this.vval = new Float64Array(1024);
  }
  setPos(p) { this.p = p; }
  clearTT() { this.ttKey.fill(0); this.ttDepth.fill(0); this.ttFlag.fill(0); this.ttMove.fill(0); }

  // 重ね合わせ駒の価値。w は陣営ごとの残り駒数の重み
  pieceValue(pm, prom, w) {
    const tb = prom ? V1 : V0;
    let sum = 0, cnt = 0, mx = 0;
    for (let t = 1; t < 8; t++) {
      if (pm >> t & 1) {
        const v = tb[t], c = w[t] > 0 ? w[t] : 0.5;
        sum += v * c; cnt += c;
        if (v > mx) mx = v;
      }
    }
    if (cnt === 0) return 0;
    const avg = sum / cnt;
    return avg + this.params.flex * (mx - avg);
  }

  evaluate(alpha, beta) {
    const p = this.p, P = this.params, pr = p.pruned;
    // 陣営ごとの残り枚数（確定駒を除く）
    const w0 = this.w0 || (this.w0 = new Float64Array(8)), w1 = this.w1 || (this.w1 = new Float64Array(8));
    for (let t = 0; t < 8; t++) { w0[t] = CAP[t]; w1[t] = CAP[t]; }
    for (let id = 0; id < 40; id++) {
      const m = pr[id];
      if (POPCNT[m] === 1) { const t = 31 - Math.clz32(m); if (id < 20) w0[t]--; else w1[t]--; }
    }
    const st = ++this.vstamp, vs = this.vst, vv = this.vval;
    let mat0 = 0, mat1 = 0, kc0 = 0, kc1 = 0, adv0 = 0, adv1 = 0;
    for (let id = 0; id < 40; id++) {
      const o = p.owner[id], sq = p.pos[id], pm = pr[id];
      const ci = (id < 20 ? 0 : 512) + (p.prom[id] << 8) + pm;
      let v;
      if (vs[ci] === st) v = vv[ci];
      else { v = this.pieceValue(pm, p.prom[id], id < 20 ? w0 : w1); vs[ci] = st; vv[ci] = v; }
      if (sq < 0) v *= P.hand;
      if (o === 0) {
        mat0 += v;
        if (sq >= 0) {
          if (pm & BK) kc0++;
          else if (pm === BP && !p.prom[id]) adv0 += 6 - ROW[sq];
        }
      } else {
        mat1 += v;
        if (sq >= 0) {
          if (pm & BK) kc1++;
          else if (pm === BP && !p.prom[id]) adv1 += ROW[sq] - 2;
        }
      }
    }
    const kc = P.kc, kl = kc.length - 1;
    let score = (mat0 - mat1) + P.advance * (adv0 - adv1) - kc[kc0 < kl ? kc0 : kl] + kc[kc1 < kl ? kc1 : kl];
    if (p.side === 1) score = -score;
    score += P.tempo;
    // 遅延評価：窓から大きく外れていれば利きの計算を省く
    if (alpha !== undefined && (score + LAZY <= alpha || score - LAZY >= beta)) return score | 0;

    const att0 = p.att[0], att1 = p.att[1];
    att0.fill(0); att1.fill(0);
    let mob0 = 0, mob1 = 0;
    const dm = p.dm, tl = p.tl;
    for (let id = 0; id < 40; id++) {
      if (p.pos[id] < 0) continue;
      const n = p.targets(id);
      if (p.owner[id] === 0) { for (let i = 0; i < n; i++) { const t = tl[i]; dm[t] = 0; att0[t]++; } mob0 += n; }
      else { for (let i = 0; i < n; i++) { const t = tl[i]; dm[t] = 0; att1[t]++; } mob1 += n; }
    }
    let pos = P.mob * (mob0 - mob1) - this.kingSafety(0, att0, att1) + this.kingSafety(1, att1, att0);
    if (p.side === 1) pos = -pos;
    return (score + pos) | 0;
  }

  kingSafety(side, own, opp) {
    const p = this.p, P = this.params, pr = p.pruned;
    let pen = 0, kc = 0;
    for (let id = side * 20; id < side * 20 + 20; id++) if (p.pos[id] >= 0 && (pr[id] & BK)) kc++;
    const ka = P.kAtt[Math.min(kc, P.kAtt.length - 1)];
    const lo = side * 20;
    for (let id = lo; id < lo + 20; id++) {
      const sq = p.pos[id];
      if (sq < 0 || !(pr[id] & BK)) continue;
      if (opp[sq]) pen += own[sq] ? ka >> 1 : ka;
      if (pr[id] === BK) {
        // 確定玉：周囲の利き
        const nb = STEPS[0][0][sq];
        for (let i = 0; i < nb.length; i++) {
          const t = nb[i];
          if (opp[t]) pen += opp[t] > own[t] ? P.kZone : P.kZone >> 1;
        }
      }
    }
    return pen;
  }

  // 手の並べ替え用の駒価値
  victimScore(q) {
    const pm = this.p.pruned[q];
    return QV[this.p.prom[q]][pm & ~BK] + (pm & BK ? 250 : 0);
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

  orderMoves(off, n, ttMove, ply) {
    const p = this.p, mb = this.moveBuf, sb = this.scoreBuf, board = p.board;
    const k1 = this.killers[ply * 2], k2 = this.killers[ply * 2 + 1];
    for (let i = off; i < off + n; i++) {
      const m = mb[i];
      if (m === ttMove) { sb[i] = 1 << 29; continue; }
      const id = m & 63, to = (m >> 6) & 127;
      const q = board[to];
      let s;
      if (q >= 0) {
        s = (1 << 26) + this.victimScore(q) * 16 - (p.pos[id] < 0 ? 0 : (POPCNT[p.pruned[id]] > 1 ? 300 : V0[31 - Math.clz32(p.pruned[id])] >> 2));
      } else if (m === k1) s = (1 << 25) + 2;
      else if (m === k2) s = (1 << 25) + 1;
      else s = this.history[id * 81 + to];
      if ((m >> 13) & 1) s += 400;
      // 可能性を多く残す手を少し優先
      s += POPCNT[(m >> 14) & 255] * 4;
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

  qsearch(alpha, beta, ply, qd) {
    const p = this.p;
    if (this.timeUp()) return 0;
    p.prune();
    const s = p.side;
    const ok = p.kingOnly(s ^ 1);
    if (ok >= 0 && p.attackedBy(p.pos[ok], s)) return WIN - ply - 1;
    const mk = p.kingOnly(s);
    const danger = mk >= 0 && p.attackedBy(p.pos[mk], s ^ 1);
    let best = -INF, stand = 0;
    if (!danger) {
      stand = this.evaluate(alpha, beta);
      if (stand >= beta || qd >= 7 || ply >= this.MAXPLY - 2) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
    } else if (qd >= 10 || ply >= this.MAXPLY - 2) {
      return this.evaluate() - 300;
    }
    const off = ply * 3000;
    const n = p.gen(this.moveBuf, off, !danger);
    if (danger && n === 0) return -WIN + ply;
    this.orderMoves(off, n, 0, ply);
    const lastTo = qd >= 2 ? p.lastTo() : -1;
    const mb = this.moveBuf, sb = this.scoreBuf;
    // 枝刈りの判定は子局面を探索する前（pruned が有効なうち）に済ませる
    if (!danger) {
      for (let i = off; i < off + n; i++) {
        const m = mb[i], to = (m >> 6) & 127, q = p.board[to];
        const vv = this.victimScore(q);
        let skip = false;
        if (qd >= 2 && to !== lastTo && vv < 800) skip = true;
        else if (stand + vv + 250 <= alpha) skip = true;
        else {
          const id = m & 63;
          const av = QV[p.prom[id] | ((m >> 13) & 1)][(m >> 14) & 255 & ~BK] + ((m >> 14) & BK ? 400 : 0);
          if (av > vv + 50 && p.attackedBy(to, s ^ 1)) skip = true;
        }
        if (skip) sb[i] = -INF;
      }
    }
    for (let i = off; i < off + n; i++) {
      const m = this.pick(i, off + n);
      if (sb[i] === -INF) break;
      if (p.make(m)) { p.unmake(); return WIN - ply - 1; }
      const v = -this.qsearch(-beta, -alpha, ply + 1, qd + 1);
      p.unmake();
      if (this.stop) return 0;
      if (v > best) {
        best = v;
        if (v > alpha) { alpha = v; if (v >= beta) break; }
      }
    }
    return best;
  }

  search(depth, alpha, beta, ply, allowNull) {
    const p = this.p;
    if (this.timeUp()) return 0;
    if (ply > 0 && p.repetitions(24) > 0) return 0;
    p.prune();
    const s = p.side;
    const ok = p.kingOnly(s ^ 1);
    if (ok >= 0 && p.attackedBy(p.pos[ok], s)) return WIN - ply - 1;
    const mk = p.kingOnly(s);
    const danger = mk >= 0 && p.attackedBy(p.pos[mk], s ^ 1);
    if (danger && ply < this.rootDepth * 2) depth++;
    if (depth <= 0 || ply >= this.MAXPLY - 4) return this.qsearch(alpha, beta, ply, 0);

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

    // ヌルムーブ枝刈り
    if (!pv && !danger && allowNull && depth >= 3 && ply > 0) {
      const ev = this.evaluate(beta - 1, beta);
      if (ev >= beta) {
        p.makeNull();
        const r = depth >= 7 ? 3 : 2;
        const v = -this.search(depth - 1 - r, -beta, -beta + 1, ply + 1, false);
        p.unmakeNull();
        if (this.stop) return 0;
        if (v >= beta) return v >= WIN - 1000 ? beta : v;
      }
      p.prune();
    }

    const off = ply * 3000;
    const n = p.gen(this.moveBuf, off, false);
    if (n === 0) return -WIN + ply;
    this.orderMoves(off, n, ttMove, ply);

    const alpha0 = alpha;
    let best = -INF, bestMove = 0, searched = 0;
    for (let i = off; i < off + n; i++) {
      const m = this.pick(i, off + n);
      const to = (m >> 6) & 127;
      const isCap = p.board[to] >= 0;
      if (p.make(m)) {
        p.unmake();
        best = WIN - ply - 1; bestMove = m;
        break;
      }
      let v;
      if (searched === 0) {
        v = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        let red = 0;
        if (depth >= 3 && searched >= 3 && !isCap && !danger && !((m >> 13) & 1)) {
          red = 1 + (searched >= 10 ? 1 : 0) + (depth >= 6 && searched >= 20 ? 1 : 0);
          if (red > depth - 2) red = depth - 2;
        }
        v = -this.search(depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
        if (!this.stop && v > alpha && red > 0) v = -this.search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (!this.stop && v > alpha && v < beta) v = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      }
      p.unmake();
      if (this.stop) return 0;
      searched++;
      if (ply === 0 && (v > best || searched === 1)) {
        this.rootBest = m; this.rootScore = v;
      }
      if (v > best) {
        best = v; bestMove = m;
        if (v > alpha) {
          alpha = v;
          if (v >= beta) {
            if (!isCap) {
              const kb = ply * 2;
              if (this.killers[kb] !== m) { this.killers[kb + 1] = this.killers[kb]; this.killers[kb] = m; }
              const hi = (m & 63) * 81 + to;
              this.history[hi] += depth * depth;
              if (this.history[hi] > 1 << 20) for (let k = 0; k < this.history.length; k++) this.history[k] >>= 1;
            }
            break;
          }
        }
      }
    }
    const flag = best >= beta ? 2 : best > alpha0 ? 1 : 3;
    this.ttStore(depth, flag, best, bestMove, ply);
    return best;
  }

  // 思考。timeMs ミリ秒で反復深化
  think(timeMs, maxDepth, onInfo) {
    const p = this.p;
    this.nodes = 0; this.stop = false;
    const start = now();
    this.deadline = start + timeMs;
    this.killers.fill(0);
    for (let k = 0; k < this.history.length; k++) this.history[k] >>= 2;
    p.prune();
    const all = new Int32Array(8192);
    const n = p.gen(all, 0, false);
    if (n === 0) return { move: 0, score: -WIN, depth: 0, nodes: 0, pv: [] };
    // 即勝ち
    for (let i = 0; i < n; i++) {
      if (p.make(all[i])) { p.unmake(); return { move: all[i], score: WIN, depth: 1, nodes: 1, pv: [all[i]] }; }
      p.unmake();
    }
    if (n === 1) return { move: all[0], score: 0, depth: 0, nodes: 1, pv: [all[0]] };
    let bestMove = all[0], bestScore = 0, done = 0;
    maxDepth = maxDepth || 40;
    for (let d = 1; d <= maxDepth; d++) {
      this.rootDepth = d;
      this.rootBest = 0;
      let v;
      if (d >= 4 && Math.abs(bestScore) < WIN - 1000) {
        let a = bestScore - 120, b = bestScore + 120;
        v = this.search(d, a, b, 0, false);
        if (!this.stop && (v <= a || v >= b)) v = this.search(d, -INF, INF, 0, false);
      } else {
        v = this.search(d, -INF, INF, 0, false);
      }
      if (this.stop) {
        if (this.rootBest && this.rootScore > bestScore) { bestMove = this.rootBest; bestScore = this.rootScore; }
        break;
      }
      const ti = this.ttProbe();
      bestMove = ti >= 0 && this.ttMove[ti] ? this.ttMove[ti] : (this.rootBest || bestMove);
      bestScore = v; done = d;
      if (onInfo) onInfo({ depth: d, score: v, nodes: this.nodes, time: now() - start, pv: this.pv(bestMove, d) });
      if (Math.abs(v) >= WIN - 1000) break;
      if (now() - start > timeMs * 0.55) break;
    }
    return { move: bestMove, score: bestScore, depth: done, nodes: this.nodes, time: now() - start, pv: this.pv(bestMove, done) };
  }

  pv(first, maxLen) {
    const p = this.p, out = [];
    if (!first) return out;
    let m = first, k = 0;
    while (m && k < Math.max(1, maxLen)) {
      out.push(m);
      p.make(m); k++;
      const ti = this.ttProbe();
      if (ti < 0) break;
      m = this.ttMove[ti];
      p.prune();
      // 不正な手（ハッシュ衝突）を避ける
      const buf = this.moveBuf;
      const n = p.gen(buf, 0, false);
      let found = false;
      for (let i = 0; i < n; i++) if (buf[i] === m) { found = true; break; }
      if (!found) break;
    }
    while (k-- > 0) p.unmake();
    return out;
  }
}

const INF = 1 << 30, WIN = 10000000, LAZY = 400;
const now = (typeof performance !== 'undefined' && performance.now) ? () => performance.now() : () => Date.now();

const QS = {
  Pos, Searcher, decode, PARAMS, WIN,
  BK, BR, BB, BG, BS, BN, BL, BP, ALL, PROMOTABLE, POPCNT, ROW, COL,
};
if (typeof module !== 'undefined' && module.exports) module.exports = QS;
else root.QS = QS;
})(typeof self !== 'undefined' ? self : this);
