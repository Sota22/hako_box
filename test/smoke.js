const QS = require('../src/engine.js');
const p = new QS.Pos();
let ms = p.legalMoves();
console.log('initial moves', ms.length);
// random games: invariants
let rng = 12345; const r = n => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
let games = 0, plies = 0, wins = [0,0,0];
const t0 = Date.now();
for (let g = 0; g < 300; g++) {
  const q = new QS.Pos();
  let res = 2;
  for (let k = 0; k < 400; k++) {
    const mv = q.legalMoves();
    if (!mv.length) { res = q.side ^ 1; break; }
    const m = mv[r(mv.length)];
    const s = q.side;
    const w = q.make(m);
    plies++;
    if (w) { res = s; break; }
    if (!q.prune()) throw new Error('infeasible after non-winning move');
    // hash consistency
    const h1 = q.h1, h2 = q.h2; q.rehash(); if (h1 !== q.h1 || h2 !== q.h2) throw new Error('hash mismatch');
    for (let id = 0; id < 40; id++) if (q.pruned[id] === 0) throw new Error('empty mask');
  }
  // unmake all and compare with initial
  while (q.usp > 0) q.unmake();
  const init = new QS.Pos();
  if (JSON.stringify(q.serialize()) !== JSON.stringify(init.serialize())) throw new Error('unmake mismatch');
  wins[res]++; games++;
}
console.log('random games', games, 'plies', plies, 'results', wins, 'ms', Date.now() - t0);
// search speed
const s = new QS.Searcher(new QS.Pos());
const res = s.think(3000, 40, i => console.log('d', i.depth, 'score', i.score, 'nodes', i.nodes, 'ms', Math.round(i.time)));
console.log(QS.decode(res.move), res.depth, res.nodes);
