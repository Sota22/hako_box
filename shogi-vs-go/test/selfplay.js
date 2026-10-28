// AI 同士の対局で勝率を測る
//   node test/selfplay.js '{"goal":10}' games ms ['{将棋側の評価パラメータ}'] ['{囲碁側の評価パラメータ}']
const { fork } = require('child_process');
const SG = require('../src/engine.js');
if (process.argv[2] === '--child') {
  process.on('message', ({ rules, ms, seed, PS, PG, msS, msG }) => {
    const p = new SG.Pos(rules);
    const ss = new SG.Searcher(p, 18), sg = new SG.Searcher(p, 18);
    ss.override = PS || {}; sg.override = PG || {};
    ss.noise = seed; sg.noise = seed * 7 + 1;
    let winner = -1, plies = 0, reason = '';
    const tl = []; // [将棋が取った石, 囲碁が取った駒, 玉が取られたか] の推移
    for (let k = 0; k < 600; k++) {
      const q = new SG.Pos(rules); q.load(p.serialize());
      const s = p.side === SG.SHOGI ? ss : sg;
      s.setPos(q);
      const legal = q.legalMoves();
      const m = legal.length === 1 ? legal[0] : legal.length ? s.think(p.side === SG.SHOGI ? (msS || ms) : (msG || ms), 40).move : -1;
      if (m === -1) {
        if (p.side === SG.GO && p.left >= p.perTurn) { winner = p.areaWinner(); reason = 'area'; }
        else { winner = p.side ^ 1; reason = 'nomove'; }
        break;
      }
      const mover = p.side;
      const w = p.make(m); plies++;
      if (w < 0) throw new Error('illegal');
      tl.push([p.caps, p.lost, p.kingSq < 0 ? 1 : 0]);
      if (w === 2) { winner = mover ^ 1; reason = 'supply-area'; break; }
      if (w > 0) { winner = mover; reason = mover === SG.SHOGI ? 'caps' : p.kingSq < 0 ? 'king' : p.placed >= p.supply ? 'supply' : 'take'; break; }
    }
    let pieces = 0; for (let i = 0; i < 81; i++) if (p.board[i] > 0 && p.board[i] < SG.STONE) pieces++;
    process.send({ winner, plies, reason, caps: p.caps, pieces, stones: p.stones, lost: p.lost, tl });
  });
} else {
  const rules = JSON.parse(process.argv[2] || '{}');
  const games = +process.argv[3] || 20, ms = +process.argv[4] || 200;
  const PS = JSON.parse(process.argv[5] || '{}'), PG = JSON.parse(process.argv[6] || '{}');
  const msS = +process.argv[7] || 0, msG = +process.argv[8] || 0;
  const par = 4;
  let next = 0, done = 0;
  const out = [];
  const run = () => {
    if (next >= games) return;
    const g = next++;
    const c = fork(__filename, ['--child']);
    c.send({ rules, ms, seed: 101 + g * 7919, PS, PG, msS, msG });
    c.on('message', r => {
      out.push(r); done++; c.kill();
      if (done === games) report(); else run();
    });
  };
  const report = () => {
    const sw = out.filter(r => r.winner === SG.SHOGI).length, gw = out.filter(r => r.winner === SG.GO).length;
    const avg = k => (out.reduce((a, r) => a + r[k], 0) / out.length).toFixed(1);
    const reasons = {}; for (const r of out) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    if (process.env.DETAIL) console.log(JSON.stringify(out.map(r => [r.winner, r.caps, r.plies, r.lost])));
    if (process.env.TIMELINE) require('fs').writeFileSync(process.env.TIMELINE, JSON.stringify(out));
    console.log(`${JSON.stringify(rules)} 将棋 ${sw} - 囲碁 ${gw} (将棋 ${(100 * sw / games).toFixed(0)}%) 手数 ${avg('plies')} 取った石 ${avg('caps')} 残り駒 ${avg('pieces')} 盤上の石 ${avg('stones')} ${JSON.stringify(reasons)}`);
  };
  for (let i = 0; i < par; i++) run();
}
