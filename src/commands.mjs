export const MESSAGE_COMMAND = "mcfunctionを色付け";
export const SLASH_COMMAND = "mcfunction";

// User Install; available in servers, bot DMs, and private/group DMs.
const contexts = { integration_types: [1], contexts: [0, 1, 2] };
export const commands = [
  { name: MESSAGE_COMMAND, type: 3, ...contexts },
  {
    name: SLASH_COMMAND,
    type: 1,
    description: "mcfunctionをDiscordのANSIコードブロックに色付けします",
    ...contexts,
    options: [
      { name: "code", description: "mcfunction本文。省略すると入力フォームを開きます", type: 3, max_length: 4000 },
      { name: "private", description: "自分だけに表示（既定: false）", type: 5 },
      { name: "no-comments", description: "コメント行を除外", type: 5 },
      { name: "no-blank", description: "空行を除外", type: 5 },
      { name: "color", description: "カラーコード（既定: 24bit）", type: 3,
        choices: [{ name: "24bit（Web版と同じ）", value: "truecolor" }, { name: "8色", value: "basic" }] }
    ]
  }
];
