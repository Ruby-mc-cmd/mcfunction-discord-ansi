# [mcfunction → Discord](https://ruby-mc-cmd.github.io/mcfunction-discord-ansi/)

mcfunction のコードを貼ると、Discord の `ansi` コードブロックで VS Code（Spyglass）と同じように色分けされるテキストを作るツールです。

## 使い方

1. `index.html` をブラウザで開く（GitHub Pages で公開している場合はそのページを開く）
2. mcfunction を入力欄に貼り付ける
3. プレビューで色を確認する
4. 「Discord 用にコピー」を押して、Discord のメッセージ欄に貼って送信する

「コメント行を除外」「空行を除外」で、送る前に行を減らせます。

## 色分け

VS Code（Dark Modern テーマ）＋ Spyglass と同じ色を、カラーコード（24bit）で指定します。24bit カラーに対応していない Discord では、近い8色で表示されます。

| 要素 | 例 | VS Code の色 | 8色での表示 |
|---|---|---|---|
| コマンド | `execute` `scoreboard` | `#C586C0` | ピンク（35） |
| サブコマンド・リテラル | `if` `run` `players` `float` | `#569CD6` | 青（34） |
| セレクター | `@a` `@s` | `#569CD6` | 青（34） |
| スコアホルダー・スコア名・タグ | `#phh` `vphys` | `#9CDCFE` | ティール（36） |
| NBT パス・キー | `ph.x` `tag=` `Count:` | `#9CDCFE` | ティール（36） |
| リソースID | `vphys:sneaking` `#minecraft:logs` | `#DCDCAA` | 黄（33） |
| 数値・座標 | `1800` `~` `^1` `1..5` | `#B5CEA8` | 緑（32） |
| 文字列 | `"text"` | `#CE9178` | 赤（31） |
| コメント | `# …` | `#6A9955` | 緑（32） |
| 括弧（入れ子の深さ順） | `[` `{` `(` | `#FFD700` → `#DA70D6` → `#179FFF` | 黄 → ピンク → 青 |
| マクロ行の `$` | `$execute` `$(k1)` | `#569CD6` | 青（34） |
| マクロ行の本文 | `$` と括弧と変数以外 | `#CE9178` | 赤（31） |
| マクロ変数名 | `k1` | `#9CDCFE` | ティール（36） |

## 注意

- 24bit カラー（`38;2;R;G;B`）は、Discord で試験的に表示されている機能です。表示されない環境があります。
- 色は見る人の Discord で描画されます。相手が 24bit カラーに対応していない場合は8色で表示されます。
- モバイル版の Discord では色が付かない場合があります。
- 1メッセージ2000文字（Nitro は4000文字）を超えると送信できません。カラーコードの分、元のコードより文字数が増えます。

## 参考

- [Rebane's Discord Colored Text Generator](https://gist.github.com/rebane2001/07f2d8e80df053c70a1576d27eabe97c)
- [Spyglass](https://github.com/SpyglassMC/Spyglass)
