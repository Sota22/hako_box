// AI同士の対局で設定を比較する: node test/selfplay.js '{"flex":0.4}' '{}' games ms
const { fork } = require('child_process');
const QS = require('../src/engine.js');
if (process.argv[2] === '--child') {
  process.on('message', ({ A, B, aSide, ms, seed }) => {
    const p = new QS.Pos();
    p.normalize();
    const sa = new QS.Searcher(p, 18), sb = new QS.Searcher(p, 18);
    Object.assign(sa.params, A); Object.assign(sb.params, B);
    let rng = seed;
    const r = n => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
    const hist = [[p.h1, p.h2]];
    let result = 0.5, plies = 0;
    // 序盤をばらけさせるため最初の1手はランダム
    for (let k = 0; k < 300; k++) {
      const q = new QS.Pos(); q.load(p.serialize());
      for (const x of hist) q.pushHistory(x[0], x[1]);
      let m;
      if (k < 1) { const mv = q.legalMoves(); m = mv[r(mv.length)]; }
      else {
        const s = (p.side === aSide) ? sa : sb;
        s.setPos(q);
        m = s.think(ms, 40).move;
      }
      if (!m) { result = p.side === aSide ? 0 : 1; break; }
      const mover = p.side;
      const w = p.make(m); plies++;
      if (w) { result = mover === aSide ? 1 : 0; break; }
      p.normalize(); p.usp = 0; p.hsp = 0;
      hist.push([p.h1, p.h2]);
      let rep = 0; for (const x of hist) if (x[0] === p.h1 && x[1] === p.h2) rep++;
      if (rep >= 4) break;
    }
    process.send({ result, plies });
  });
} else {
  const A = JSON.parse(process.argv[2] || '{}'), B = JSON.parse(process.argv[3] || '{}');
  const games = +process.argv[4] || 20, ms = +process.argv[5] || 200, par = 4;
  let next = 0, done = 0, score = 0, totalPlies = 0;
  const results = [];
  const run = () => {
    if (next >= games) return;
    const g = next++;
    const c = fork(__filename, ['--child']);
    c.send({ A, B, aSide: g % 2, ms, seed: 1000 + (g >> 1) * 7919 });
    c.on('message', ({ result, plies }) => {
      score += result; totalPlies += plies; done++; results.push(result);
      c.kill();
      if (done === games) {
        console.log(`A vs B: ${score}/${games} (${(100 * score / games).toFixed(1)}%) avg plies ${(totalPlies / games).toFixed(0)} [${results.join(' ')}]`);
      } else run();
    });
  };
  for (let i = 0; i < par; i++) run();
}
