// 1局を表示: node test/show.js '{"goal":30}' ms [plies to show every]
const SG = require('../src/engine.js');
const rules = JSON.parse(process.argv[2] || '{}'), ms = +process.argv[3] || 200, every = +process.argv[4] || 10;
const PS = JSON.parse(process.argv[5] || '{}'), PG = JSON.parse(process.argv[6] || '{}');
const CH = { 0: '・', 1: '玉', 2: '飛', 3: '角', 4: '金', 5: '銀', 6: '桂', 7: '香', 8: '歩', 10: '龍', 11: '馬', 13: '全', 14: '圭', 15: '杏', 16: 'と', 20: '●' };
const show = p => { let s = ''; for (let r = 0; r < 9; r++) { for (let c = 0; c < 9; c++) s += CH[p.board[r * 9 + c]]; s += '\n'; } return s; };
const p = new SG.Pos(rules);
const ss = new SG.Searcher(p, 18), sg = new SG.Searcher(p, 18);
ss.override = PS; sg.override = PG;
const log = [];
for (let k = 0; k < 400; k++) {
  const q = new SG.Pos(rules); q.load(p.serialize());
  const s = p.side === 0 ? ss : sg; s.setPos(q);
  const r = s.think(ms, 40);
  if (!r.move) { console.log('no move for', p.side); break; }
  const d = SG.decode(r.move);
  const sq = x => (9 - (x % 9)) + '' + (((x / 9) | 0) + 1);
  log.push((p.side ? 'G' : 'S') + (d.go ? sq(d.to) : sq(d.from) + sq(d.to) + (d.prom ? '+' : '')) + '(' + r.score + ')');
  const w = p.make(r.move);
  if (k % every === every - 1 || w) { console.log(`ply ${k + 1} caps ${p.caps} stones ${p.stones}`); console.log(show(p)); }
  if (w) { console.log('winner', p.side ^ 1 ? 'GO' : 'SHOGI'); break; }
}
console.log(log.join(' '));
