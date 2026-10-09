// AI の指し手が合法手に含まれるか、打った瞬間に候補がどう変わるかを調べる
const QS = require('../src/engine.js');
const K = ['玉','飛','角','金','銀','桂','香','歩'];
const ch = m => K.filter((_, t) => m >> t & 1).join('');
let illegal = 0, drops = 0, collapses = 0;
for (let g = 0; g < +(process.argv[2] || 6); g++) {
  const p = new QS.Pos(); p.normalize();
  const S = new QS.Searcher(p, 18);
  const hist = [[p.h1, p.h2]];
  let rng = 17 + g; const r = n => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
  for (let k = 0; k < 200; k++) {
    const legal = p.legalMoves();
    if (!legal.length) break;
    let m;
    if (k === 0) m = legal[r(legal.length)];
    else {
      const q = new QS.Pos(); q.load(p.serialize()); for (const x of hist) q.pushHistory(x[0], x[1]);
      S.setPos(q); m = S.think(120, 40).move;
    }
    if (!legal.includes(m)) { illegal++; console.log('ILLEGAL move from search', g, k, QS.decode(m)); }
    const d = QS.decode(m);
    const isDrop = p.pos[d.id] < 0;
    const before = p.mask[d.id];
    const w = p.make(m);
    if (w) break;
    p.normalize(); p.usp = 0; p.hsp = 0; hist.push([p.h1, p.h2]);
    if (isDrop) {
      drops++;
      if (p.mask[d.id] !== before) {
        collapses++;
        const row = (d.to / 9) | 0;
        console.log(`drop g${g} k${k} side${p.side ^ 1} army${d.id < 20 ? 0 : 1} row${row + 1}: ${ch(before)} -> ${ch(p.mask[d.id])}`);
      }
    }
  }
}
console.log({ illegal, drops, collapses });
