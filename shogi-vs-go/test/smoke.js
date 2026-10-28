// ルールの不変条件チェック（ランダム対局）と探索の速度
const SG = require('../src/engine.js');
let rng = 12345; const r = n => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
const p0 = new SG.Pos();
console.log('initial legal', p0.legalMoves().length, 'side', p0.side);
let games = 0, plies = 0; const res = { shogi: 0, go: 0, noMove: [0, 0] };
const t0 = Date.now();
for (let g = 0; g < 400; g++) {
  const q = new SG.Pos({ goal: 30, first: g % 2, perTurn: 1 + (g % 3 > 0 ? 1 : 0), eatChain: g % 5 !== 0 });
  const init = JSON.stringify(q.serialize());
  for (let k = 0; k < 600; k++) {
    const mv = q.legalMoves();
    if (!mv.length) { res.noMove[q.side]++; break; }
    const m = mv[r(mv.length)];
    const s = q.side;
    const w = q.make(m);
    if (w < 0) throw new Error('legal move rejected');
    plies++;
    const h1 = q.h1, h2 = q.h2; q.rehash(); if (h1 !== q.h1 || h2 !== q.h2) throw new Error('hash mismatch');
    // 盤上の連はすべて呼吸点を持つ
    for (let sq = 0; sq < 81; sq++) if (q.board[sq] && q.libertyCount(sq) === 0) throw new Error('group without liberty at ' + sq);
    let st = 0, king = -1; for (let sq = 0; sq < 81; sq++) { if (q.board[sq] === SG.STONE) st++; if (q.board[sq] === SG.K) king = sq; }
    if (st !== q.stones || king !== q.kingSq) throw new Error('count mismatch');
    if (w > 0) { if (s === SG.SHOGI) { if (q.caps < q.goal) throw new Error('bad shogi win'); res.shogi++; } else { if (king >= 0) throw new Error('bad go win'); res.go++; } break; }
  }
  while (q.usp > 0) q.unmake();
  if (JSON.stringify(q.serialize()) !== init) throw new Error('unmake mismatch');
  games++;
}
console.log('random games', games, 'plies', plies, res, 'ms', Date.now() - t0);
const s = new SG.Searcher(new SG.Pos());
for (const side of [0, 1]) {
  const p = new SG.Pos({ first: side });
  s.setPos(p);
  const out = s.think(3000, 40, i => console.log(' d', i.depth, 'score', i.score, 'nodes', i.nodes, 'ms', Math.round(i.time)));
  console.log(side ? 'GO' : 'SHOGI', SG.decode(out.move), 'depth', out.depth, 'nps', Math.round(out.nodes / out.time * 1000));
}
