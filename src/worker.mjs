import { MESSAGE_COMMAND, SLASH_COMMAND } from "./commands.mjs";
import { extractCodeBlocks, formatCode, splitAnsi } from "./format.mjs";

const EPHEMERAL = 64;
const encoder = new TextEncoder();
const json = (body, status = 200) => Response.json(body, { status });
const message = (content, isPrivate = true) => ({
  type: 4, data: { content, flags: isPrivate ? EPHEMERAL : 0, allowed_mentions: { parse: [], replied_user: false } }
});

function hexBytes(hex, size) {
  if (typeof hex !== "string" || !new RegExp(`^[a-f0-9]{${size * 2}}$`, "i").test(hex)) return null;
  return Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
}

export async function verifyRequest(request, body, publicKey) {
  const signature = hexBytes(request.headers.get("X-Signature-Ed25519"), 64);
  const keyBytes = hexBytes(publicKey, 32);
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !keyBytes || !/^\d+$/.test(timestamp ?? "")) return false;
  // Reject old requests to bound replay exposure.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "Ed25519", false, ["verify"]);
    const prefix = encoder.encode(timestamp);
    const signed = new Uint8Array(prefix.length + body.byteLength);
    signed.set(prefix);
    signed.set(new Uint8Array(body), prefix.length);
    return await crypto.subtle.verify("Ed25519", key, signature, signed);
  } catch {
    return false;
  }
}

function select(custom_id, options, selected) {
  return { type: 3, custom_id, min_values: 1, max_values: 1,
    options: options.map(([label, value]) => ({ label, value, default: value === selected })) };
}

function modal(code = "", options = {}) {
  if (code.length > 4000) return message("本文は4,000文字までです。コードを分けて入力してください。");
  const label = (text, component) => ({ type: 18, label: text, component });
  const filter = options.noComments ? (options.noBlank ? "both" : "comments") : (options.noBlank ? "blank" : "none");
  return {
    type: 9,
    data: {
      custom_id: "mcfunction:convert", title: "mcfunctionを色付け",
      components: [
        label("mcfunction", { type: 4, custom_id: "code", style: 2, required: true,
          min_length: 1, max_length: 4000, placeholder: "execute as @a run say hello", ...(code ? { value: code } : {}) }),
        label("表示先", select("visibility", [["自分だけに表示", "private"], ["チャンネルに送信", "public"]], options.private === true ? "private" : "public")),
        label("除外する行", select("filter", [["除外しない", "none"], ["コメント行", "comments"], ["空行", "blank"], ["コメント行と空行", "both"]], filter)),
        label("カラーコード", select("color", [["24bit（Web版と同じ）", "truecolor"], ["8色", "basic"]], options.color ?? "truecolor"))
      ]
    }
  };
}

function modalFields(components) {
  const fields = {};
  function visit(component) {
    if (component.custom_id) fields[component.custom_id] = component.value ?? component.values?.[0];
    if (component.component) visit(component.component);
    for (const child of component.components ?? []) visit(child);
  }
  for (const component of components ?? []) visit(component);
  return fields;
}

function isPrivateResponse(interaction, requested) {
  if (requested !== false) return true;
  // Discord forces user-installed apps' replies private when external apps
  // cannot send public responses. Use the same setting for all followups.
  if (interaction.guild_id && !interaction.authorizing_integration_owners?.["0"]) {
    try {
      return (BigInt(interaction.member?.permissions ?? "0") & (1n << 50n)) === 0n;
    } catch { return true; }
  }
  return false;
}

async function webhook(url, method, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, payload instanceof FormData
      ? { method, body: payload }
      : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (response.ok) return;
    let delay;
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      const seconds = Number(data.retry_after);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 5) delay = seconds * 1000;
    } else if (response.status === 404 && method === "PATCH" && attempt === 0) {
      // The deferred ACK can reach Discord just after this background request.
      delay = 250;
    }
    if (delay === undefined || attempt === 2) throw new Error(`Discord HTTP ${response.status}`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

async function sendParts(interaction, parts, ansi, flags) {
  const base = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  const original = `${base}/messages/@original`;
  try {
    if (parts.length > 5) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({
        content: "色付け後の本文が5メッセージを超えるため、全文をファイルにしました。分けて入力するとDiscord上でも表示できます。",
        allowed_mentions: { parse: [], replied_user: false },
        attachments: [{ id: 0, filename: "mcfunction.ansi.txt", description: "ANSIコードブロックの全文" }]
      }));
      form.set("files[0]", new Blob([ansi], { type: "text/plain;charset=utf-8" }), "mcfunction.ansi.txt");
      await webhook(original, "PATCH", form);
      return;
    }
    await webhook(original, "PATCH", { content: parts[0], allowed_mentions: { parse: [], replied_user: false } });
    for (const part of parts.slice(1)) {
      await webhook(base, "POST", { content: part, flags, allowed_mentions: { parse: [], replied_user: false } });
    }
  } catch {
    // Never log the interaction token, URL, code, or request body.
    console.error("Discordへの結果送信に失敗しました。");
    try {
      await webhook(original, "PATCH", {
        content: "結果の送信に失敗しました。一部だけ届いている場合があります。コードを短くして再実行してください。",
        allowed_mentions: { parse: [], replied_user: false }
      });
    } catch { console.error("Discordへのエラー通知に失敗しました。"); }
  }
}

function convert(interaction, code, options, ctx) {
  if (typeof code !== "string" || !code.trim()) return message("mcfunction本文を入力してください。");
  if (code.length > 4000) return message("本文は4,000文字までです。コードを分けて入力してください。");
  if (!["truecolor", "basic"].includes(options.color ?? "truecolor")) return message("カラー設定が不正です。");
  let ansi;
  try { ansi = formatCode(code, options); }
  catch (error) { return message(error.message); }
  const parts = splitAnsi(ansi);
  const privateReply = isPrivateResponse(interaction, options.private);
  if (parts.length === 1) return message(parts[0], privateReply);
  if (!/^\d{17,20}$/.test(interaction.application_id ?? "") ||
      !/^[A-Za-z0-9._-]+$/.test(interaction.token ?? "")) return message("応答用の情報がありません。");
  const flags = privateReply ? EPHEMERAL : 0;
  ctx.waitUntil(sendParts(interaction, parts, ansi, flags));
  return { type: 5, data: { flags } };
}

export function handleInteraction(interaction, ctx) {
  if (interaction.type === 1) return { type: 1 };
  const data = interaction.data;
  if (interaction.type === 2 && data?.type === 3 && data.name === MESSAGE_COMMAND) {
    const source = data.resolved?.messages?.[data.target_id]?.content;
    if (typeof source !== "string" || !source.trim()) return message("選んだメッセージに本文がありません。/mcfunction からコードを入力してください。");
    const code = extractCodeBlocks(source);
    if (!code) return message("選んだメッセージにコードブロックがありません。コードをコードブロックで囲むか、/mcfunction から入力してください。");
    // An original response to a MESSAGE command is automatically attributed
    // to its target by Discord (message_reference / referenced_message).
    // Keep this interaction instead of opening a modal so that link survives.
    return convert(interaction, code, { private: false }, ctx);
  }
  if (interaction.type === 2 && data?.type === 1 && data.name === SLASH_COMMAND) {
    const options = Object.fromEntries((data.options ?? []).map(option => [option.name, option.value]));
    const settings = { private: options.private ?? false, noComments: options["no-comments"] ?? false,
      noBlank: options["no-blank"] ?? false, color: options.color ?? "truecolor" };
    return options.code === undefined ? modal("", settings) : convert(interaction, options.code, settings, ctx);
  }
  if (interaction.type === 5 && data?.custom_id === "mcfunction:convert") {
    const fields = modalFields(data.components);
    if (!["private", "public"].includes(fields.visibility) || !["none", "comments", "blank", "both"].includes(fields.filter)) {
      return message("フォームの設定が不正です。コマンドを再実行してください。");
    }
    return convert(interaction, fields.code, { private: fields.visibility !== "public", color: fields.color,
      noComments: ["comments", "both"].includes(fields.filter), noBlank: ["blank", "both"].includes(fields.filter) }, ctx);
  }
  return message("対応していない操作です。/mcfunction を実行してください。");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") return json({ name: "mcfunction-discord-ansi", interactions: "/interactions" });
    if (url.pathname !== "/interactions") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (!hexBytes(env.DISCORD_PUBLIC_KEY, 32)) return new Response("Public key is not configured", { status: 503 });
    const body = await request.arrayBuffer();
    if (body.byteLength > 128 * 1024) return new Response("Payload too large", { status: 413 });
    if (!await verifyRequest(request, body, env.DISCORD_PUBLIC_KEY)) return new Response("Invalid signature", { status: 401 });
    let interaction;
    try { interaction = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { return new Response("Invalid JSON", { status: 400 }); }
    if (!interaction || typeof interaction !== "object") return new Response("Invalid interaction", { status: 400 });
    return json(handleInteraction(interaction, ctx));
  }
};
