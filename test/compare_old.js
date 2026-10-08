// 旧実装と合法手集合が一致するか確認（リファクタリング用）
const NEW = require('../src/engine.js');
const OLD = require(process.argv[2]);
let rng = 7; const r = n => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
let checked = 0;
for (let g = 0; g < 200; g++) {
  const a = new NEW.Pos(), b = new OLD.Pos();
  for (let k = 0; k < 200; k++) {
    const ma = a.legalMoves().sort((x, y) => x - y), mb = b.legalMoves().sort((x, y) => x - y);
    if (ma.join() !== mb.join()) { console.log('MISMATCH game', g, 'ply', k, ma.length, mb.length); process.exit(1); }
    checked++;
    if (!ma.length) break;
    const m = ma[r(ma.length)];
    const wa = a.make(m), wb = b.make(m);
    if (wa !== wb) { console.log('win mismatch'); process.exit(1); }
    if (wa) break;
  }
}
console.log('ok, positions checked:', checked);
