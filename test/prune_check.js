// Hall の定理による候補の絞り込みを、二部マッチングの総当たりと照合する
const QS = require('../src/engine.js');
const CAP = [1, 1, 1, 2, 2, 2, 2, 9];
function feasible(masks) { // masks: 20 駒の候補。駒種トークンへの完全マッチングが存在するか
  const tokens = []; for (let t = 0; t < 8; t++) for (let i = 0; i < CAP[t]; i++) tokens.push(t);
  const matchT = new Array(20).fill(-1);
  const tryP = (p, seen) => {
    for (let k = 0; k < 20; k++) {
      if (!(masks[p] >> tokens[k] & 1) || seen[k]) continue;
      seen[k] = 1;
      if (matchT[k] < 0 || tryP(matchT[k], seen)) { matchT[k] = p; return true; }
    }
    return false;
  };
  for (let p = 0; p < 20; p++) if (!tryP(p, new Array(20).fill(0))) return false;
  return true;
}
let rng = 99; const r = n => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
let n = 0;
for (let g = 0; g < 60; g++) {
  const p = new QS.Pos();
  for (let k = 0; k < 150; k++) {
    const mv = p.legalMoves(); // prune 済み
    for (let a = 0; a < 2; a++) {
      const masks = Array.from(p.mask.slice(a * 20, a * 20 + 20));
      for (let i = 0; i < 20; i++) {
        for (let t = 0; t < 8; t++) {
          if (!(masks[i] >> t & 1)) continue;
          const mm = masks.slice(); mm[i] = 1 << t;
          const exp = feasible(mm), got = !!(p.pruned[a * 20 + i] >> t & 1);
          if (exp !== got) { console.log('MISMATCH', g, k, a, i, t, exp, got); process.exit(1); }
          n++;
        }
      }
    }
    if (!mv.length) break;
    if (p.make(mv[r(mv.length)])) break;
  }
}
console.log('ok, checks:', n);
