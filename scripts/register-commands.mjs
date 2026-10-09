import { commands } from "../src/commands.mjs";

const { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token } = process.env;
if (!/^\d{17,20}$/.test(appId ?? "") || !token) {
  console.error(".env に DISCORD_APPLICATION_ID と DISCORD_BOT_TOKEN を設定してください。");
  process.exit(1);
}

// POST upserts only our named commands; unrelated application commands survive.
for (const command of commands) {
  const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command)
  });
  if (!response.ok) {
    console.error(`コマンド登録に失敗: ${command.name} (HTTP ${response.status})`);
    process.exit(1);
  }
  console.log(`登録しました: ${command.name}`);
}
console.log(`ユーザー追加URL: https://discord.com/oauth2/authorize?client_id=${appId}&scope=applications.commands&integration_type=1`);
