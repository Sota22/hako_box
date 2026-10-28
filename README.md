# hako_box

スマホのブラウザで遊べる1ファイルのボードゲーム集です。

| ゲーム | 遊ぶ | ソース |
|---|---|---|
| 量子将棋 | `docs/index.html` | `src/` |
| 将棋対囲碁 | `docs/shogi-vs-go/index.html` | `shogi-vs-go/` |

## 量子将棋

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

## 将棋対囲碁

駒を動かす将棋側と、石を置く囲碁側が 9×9 の盤で戦います（将棋盤の81升 = 9路盤の81か所）。

- 将棋側: 駒の動き・成りは将棋と同じ。石の上に動くと石を取る。石を規定数取れば勝ち。
- 囲碁側: 空き升に石を置く。呼吸点がなくなった駒の連を取る（囲碁と同じ）。玉を取れば勝ち。
- 将棋側も、石の連を駒で囲めば取れる。自殺手は双方禁止。
- 互角にするための調整: 囲碁側は1手番に石を2つ置く（最初の手番だけ1つ）。将棋側の勝ちに必要な石の数は、AI 同士の対局で勝率が半々に近くなる値にしてある。

| ファイル | 内容 |
|---|---|
| `shogi-vs-go/src/engine.js` | ルール判定と AI（反復深化 αβ、置換表、静止探索） |
| `shogi-vs-go/src/app.js` | 画面と操作 |
| `shogi-vs-go/build.js` | `docs/shogi-vs-go/index.html` と `dist/shogi-vs-go.html` を生成 |
| `shogi-vs-go/test/` | ルールの検証、AI 同士の対局で勝率を測るスクリプト |

```sh
node shogi-vs-go/build.js
node shogi-vs-go/test/smoke.js                       # ランダム対局でルールの不変条件を確認
node shogi-vs-go/test/selfplay.js '{"goal":36}' 24 200   # AI 同士 24局（1手0.2秒）で勝率を測る
```
