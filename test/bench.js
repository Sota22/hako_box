const QS = require('../src/engine.js');
const p = new QS.Pos(); const s = new QS.Searcher(p);
let t=Date.now(); for(let i=0;i<20000;i++){p.prune();} console.log('prune us', (Date.now()-t)/20);
t=Date.now(); for(let i=0;i<20000;i++){s.evaluate();} console.log('eval us', (Date.now()-t)/20);
const r = s.think(+process.argv[2]||5000, 40, i => console.log('d', i.depth, 'score', i.score, 'nodes', i.nodes, 'ms', Math.round(i.time), 'nps', Math.round(i.nodes/i.time*1000)));
console.log(QS.decode(r.move), r.depth, r.nodes);
