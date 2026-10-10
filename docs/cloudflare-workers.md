# Cloudflare Workers セットアップ

Discordユーザーアプリのセットアップと使い方をまとめています。Web版については [README](../README.md) を参照してください。

同じ色分けを、個人アカウントに追加したDiscordアプリから使えます。サーバーへのBOT追加や常駐プロセス、Gateway接続、KVは不要です。WorkersがDiscordのHTTP Interactionを受信し、署名を検証して応答します。

## 初回セットアップ

Node.js 22以降を使います。以下はPowerShellの例です。

1. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationを作成します。
2. **Installation** → **Installation Contexts** で **User Install** を有効にします。ユーザー追加専用なら **Guild Install** は無効にできます。**Default Install Settings** → **User Install** のscopeを `applications.commands` にします。
3. **General Information** の **Application ID** と **Public Key**、**Bot** のアプリの **Token** を取得します。個人アカウントのユーザートークンは使いません。
4. ローカル設定を用意します。

   ```powershell
   npm install
   Copy-Item .env.example .env
   Copy-Item .dev.vars.example .dev.vars
   ```

   `.env` に `DISCORD_APPLICATION_ID` と `DISCORD_BOT_TOKEN`、`.dev.vars` に `DISCORD_PUBLIC_KEY` を設定します。どちらもGitの追跡対象から除外しています。Bot Tokenはコマンド登録時だけ使い、Workerには不要です。

5. ローカルで検証し、Cloudflareにデプロイします。

   ```powershell
   npm test
   npm run check
   npx wrangler login
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npm run deploy
   ```

   `secret put` の入力欄には `.dev.vars` と同じPublic Keyを貼ります。`.dev.vars` の値は自動で本番に登録されないため、上の設定が必要です。

6. デプロイで表示されたURLに `/interactions` を付け、Developer Portalの **General Information** → **Interactions Endpoint URL** に設定して保存します。

   ```text
   https://mcfunction-discord-ansi.<your-subdomain>.workers.dev/interactions
   ```

7. コマンドを登録します。グローバル登録なので、User Installで使えます。既存の同名・同種のコマンドを更新し、他のコマンドは削除しません。

   ```powershell
   npm run register
   ```

8. スクリプトが表示するユーザー追加URL（またはInstallationのDiscord Provided Link）を開き、**自分のアプリに追加**します。Discordのメッセージを右クリックして呼び出してください。

設定変更後のコマンド再登録は `npm run register`、Worker更新は `npm run deploy` です。ローカルWorkerを試すには `npm run dev` を使います。Discordからローカル環境を呼ぶ場合は別途公開HTTPSのトンネルが必要です。

## 呼び出し方と引数

| 呼び出し | 受け取る入力 |
|---|---|
| メッセージを右クリック → アプリ → **mcfunctionを色付け** | 本文中のコードブロックだけを抜き出し、24bitで色付けして元メッセージへの参照付きで公開応答。フォームは開きません |
| `/mcfunction` | 空の入力フォームを開く。複数行の貼り付けに便利 |
| `/mcfunction code:…` | `code`を直接変換。`private`、`no-comments`、`no-blank`、`color`を指定可能 |

右クリックコマンドは通常の引数（`options`）を持てません。メッセージコマンドは `data.target_id` と `data.resolved.messages[target_id].content` で対象本文を受け取ります。追加引数を指定したい場合は `/mcfunction` の引数か入力フォームを使います。ユーザー自体を右クリックするコマンドは対象ユーザーが渡されるため、このツールではコード本文を取得できる**メッセージの右クリック**を使います。

右クリック時は、説明文やインラインコードを除き、バッククォート3つで囲まれたコードブロックを抽出します。複数あれば空行で区切って順番にまとめます。言語タグの指定は問いません。コードブロックがない場合は、自分だけにエラーを表示します。

Discordはメッセージコマンドの初回応答に、対象への `message_reference` / `referenced_message` を自動で付けます。これを使って元メッセージに紐付けるため、右クリック時はモーダルを経由せず直接応答します。長文の場合は最初のメッセージをこの参照付き応答にし、残りを追加送信します。通常の返信メッセージ（type 19）とはAPI上の種類が異なる、メッセージコマンド応答（type 23）です。元の投稿者への返信メンションは無効にしています。

例: `/mcfunction code:execute as @a run say hello private:false color:basic`

- `/mcfunction` と右クリックの既定は**公開表示**。自分だけに表示する場合は `private:true` またはフォームの「自分だけに表示」を指定します。`code` は任意で、省略すると入力フォームが開きます。投稿者はアプリです。
- サーバー側で「外部アプリを使用」の公開応答権限がない場合、公開を選んでも自分だけへの表示になります。
- `no-comments:true` はコメント行、`no-blank:true` は空行を除外します。`color` は `truecolor`（24bit、Web版と同じ、既定）または `basic`（8色）です。
- Markdownのコードブロックで囲まれた本文も受け付けます。入力済みのANSIカラーコードは除去してから色付けします。
- 入力は4,000文字まで。色付け後は2,000文字以内に分割し、最大5メッセージで返します。それを超える場合は全文の `mcfunction.ansi.txt` を添付します。添付内のANSIはDiscord上で色付き表示されません。
- メッセージ本文が空、添付ファイルのみ、コードブロックがない場合は `/mcfunction` から貼り付けてください。添付ファイルの読み取りには対応していません。
- コードの実行や既存メッセージの編集は行いません。入力をDBやログに保存せず、メンション通知も無効にしています。

## 実装と検証

- `lib/highlight.js`: ブラウザとWorkerで共用する既存の色分け処理。Web版は従来どおり `index.html` を直接開けます。
- `src/commands.mjs`: User Install対応のメッセージ／スラッシュコマンド定義。
- `src/worker.mjs`: Ed25519署名検証、PING、入力フォーム、結果送信。署名の時刻は前後5分以内のみ受け付けます。
- `src/format.mjs`: 本文中のコードブロック抽出、外側のコードブロックの取り外し、制御文字除去、カラー状態を引き継ぐ分割。
- `test/worker.test.mjs`: 署名付きHTTPリクエスト、右クリック→コードブロック抽出→直接応答、フォーム送信、引数・権限、長文分割・添付、API失敗処理の自動検証。実際のDiscordクライアントや本番Cloudflare接続は別途確認が必要です。

仕様: [User Install](https://docs.discord.com/developers/tutorials/developing-a-user-installable-app)、[Application Commands](https://docs.discord.com/developers/docs/interactions/slash-commands)、[Modal Components](https://docs.discord.com/developers/components/using-modal-components)、[Interaction応答](https://docs.discord.com/developers/interactions/receiving-and-responding)、[対象メッセージへの参照](https://docs.discord.com/developers/resources/message#message-interaction-metadata-object)、[外部アプリ権限](https://docs.discord.com/developers/topics/permissions)。
