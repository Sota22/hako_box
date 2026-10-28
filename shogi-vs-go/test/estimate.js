// selfplay.js の TIMELINE 出力から、将棋側の目標 N と碁笥の石の数 X を変えたときの将棋側の勝率を見積もる
//   TIMELINE=tl.json node test/selfplay.js '{"goal":40}' 32 1000 && node test/estimate.js tl.json
// AI の指し方はルールの数で変わるので、あくまで目安。決めた値は selfplay.js で直接確かめる。
const games = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const per = +(process.argv[3] || 2); // 囲碁側が1手番に置く数
const Ns = [30, 32, 34, 35, 36, 38, 40], Xs = [90, 100, 110];
console.log(`将棋側の勝率（${games.length}局）\nX\\N\t` + Ns.join('\t'));
for (const X of Xs) {
  const row = [X];
  for (const N of Ns) {
    let sw = 0;
    for (const g of games) {
      // 手番の並び: 囲碁1つ、その後 [将棋, 囲碁×per] の繰り返し
      let placed = 0, w = g.winner;
      for (let i = 0; i < g.tl.length; i++) {
        const goPly = i === 0 || ((i - 1) % (per + 1)) !== 0;
        const [caps, , kd] = g.tl[i];
        if (kd) { w = 1; break; }
        if (caps >= N) { w = 0; break; }
        if (goPly && ++placed >= X) { w = 1; break; } // 碁笥が尽きたら地はほぼ囲碁側
      }
      if (w === 0) sw++;
    }
    row.push((100 * sw / games.length).toFixed(0) + '%');
  }
  console.log(row.join('\t'));
}
