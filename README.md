# 量子将棋

すべての駒が「玉・飛・角・金・銀・桂・香・歩のどれか分からない」状態から始まる将棋です。
駒を動かすと、その動きができる種類に正体が絞られます（観測）。相手の「玉でしかありえない駒」を取ったら勝ち。

- スマホのブラウザで遊べる1ファイルの HTML（`docs/index.html`）
- AI 対戦（先手／後手、考える時間4段階）と 2人対戦
- AI は Web Worker 上で反復深化 αβ 探索（置換表・静止探索・ヌルムーブ・LMR）

## 構成

| ファイル | 内容 |
|---|---|
| `src/engine.js` | ルール判定と AI。陣営の駒構成との矛盾は Hall の定理で判定 |
| `src/app.js` | 画面と操作 |
| `src/style.css`, `src/template.html` | 見た目 |
| `build.js` | `docs/index.html`（GitHub Pages 用）と `dist/quantum-shogi.html` を生成 |
| `test/` | ルールの検証、速度計測、AI 同士の対局 |

```sh
node build.js            # ビルド
node test/smoke.js       # ルールの不変条件チェック（ランダム対局）
node test/selfplay.js '{"flex":0.4}' '{}' 20 200   # 設定 A と B を対局させて比較
```
