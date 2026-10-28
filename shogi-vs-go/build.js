// src/ をまとめて1ファイルの HTML を作る
//   ../dist/shogi-vs-go.html      : Artifact 用（<html> などの外枠なし）
//   ../docs/shogi-vs-go/index.html : GitHub Pages 用（完全な HTML）
const fs = require('fs');
const path = require('path');
const r = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const body = r('template.html')
  .replace('/*STYLE*/', () => r('style.css'))
  .replace('/*ENGINE*/', () => r('engine.js').replace(/<\/script/gi, '<\\/script'))
  .replace('/*APP*/', () => r('app.js'));
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.mkdirSync(path.join(root, 'docs', 'shogi-vs-go'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'shogi-vs-go.html'), body);
const full = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}</style>
</head>
<body>
${body}
</body>
</html>
`;
fs.writeFileSync(path.join(root, 'docs', 'shogi-vs-go', 'index.html'), full);
console.log('built', body.length, 'bytes');
