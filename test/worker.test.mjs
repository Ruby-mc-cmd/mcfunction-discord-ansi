import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import worker, { handleInteraction } from "../src/worker.mjs";
import { MESSAGE_COMMAND, commands } from "../src/commands.mjs";
import { extractCodeBlocks, formatCode, splitAnsi, unwrapCode } from "../src/format.mjs";
import highlighter from "../lib/highlight.js";

const ctx = () => {
  const pending = [];
  return { pending, waitUntil(promise) { pending.push(promise); } };
};
const slash = (options = []) => ({
  type: 2, application_id: "123456789012345678", token: "test_token",
  data: { type: 1, name: "mcfunction", options }
});
const fields = (values) => Object.entries(values).map(([custom_id, value]) => ({
  type: 18, component: { custom_id, ...(custom_id === "code" ? { value } : { values: [value] }) }
}));
const plain = ansi => ansi.slice(8, -4).replace(/\x1b\[[0-9;]*m/g, "");

test("commands are user-installable and include message context + slash arguments", () => {
  assert.deepEqual(commands.map(c => c.type), [3, 1]);
  for (const command of commands) {
    assert.deepEqual(command.integration_types, [1]);
    assert.deepEqual(command.contexts, [0, 1, 2]);
  }
  assert.equal(commands[0].description, undefined);
  assert.notEqual(commands[1].options.find(option => option.name === "code").required, true);
});

test("shared highlighter works as a classic browser script without Node globals", () => {
  const sandbox = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../lib/highlight.js", import.meta.url), "utf8"), sandbox);
  const code = '# comment\nexecute as @a[tag=foo] run function demo:foo\n$data modify storage demo:s foo set value "$(name)"';
  assert.equal(sandbox.McfunctionAnsi.toAnsi(sandbox.McfunctionAnsi.tokenize(code)), highlighter.toAnsi(highlighter.tokenize(code)));
  assert.ok(readFileSync(new URL("../index.html", import.meta.url), "utf8").includes('<script src="lib/highlight.js"></script>'));
});

test("normalizes fences, strips incoming ANSI, preserves macro/selector/Unicode text", () => {
  const source = '# comment\r\n$execute as @a[tag=$(name)] run say 😀\r\n';
  const ansi = formatCode('```mcfunction\n' + source + '```');
  assert.equal(plain(ansi), source.replace(/\r\n/g, "\n").trimEnd());
  assert.equal(unwrapCode('```ansi\n\x1b[31msay hello\x1b[0m\n```'), "say hello");
  assert.ok(!plain(formatCode('say ```hello```')).includes("```"));
  assert.ok(formatCode("say hi", { color: "basic" }).includes("\x1b[0;35m"));
  assert.ok(!formatCode("say hi", { color: "basic" }).includes("38;2;"));
});

test("comment/blank filters work and empty output reports an error", () => {
  assert.equal(plain(formatCode("# comment\n\nsay hi\n", { noComments: true, noBlank: true })), "say hi");
  assert.throws(() => formatCode("# comment\n", { noComments: true }), /コードがありません/);
});

test("ANSI splitting keeps all text, color state, and complete Unicode characters", () => {
  const ansi = formatCode(('execute as @a run say 😀こんにちは\n').repeat(100));
  const parts = splitAnsi(ansi);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(plain).join(""), plain(ansi));
  for (const part of parts) {
    assert.ok(part.length <= 2000);
    assert.ok(part.startsWith("```ansi\n"));
    assert.ok(part.endsWith("\x1b[0m\n```"));
    assert.ok(!/[\uD800-\uDFFF]/u.test(plain(part).replace(/😀/g, "")));
  }
  // If a chunk starts mid-colored text, its first sequence restores that color.
  const red = '\x1b[0;31m';
  const long = '```ansi\n' + red + 'a'.repeat(5000) + '\x1b[0m\n```';
  assert.ok(splitAnsi(long).every(part => part.startsWith('```ansi\n' + red)));
});

test("extracts only fenced code in order, ignoring prose and inline code", () => {
  const source = '説明 `say ignored`\n```mcfunction\r\nsay first\r\n```\n補足\n```\nsay second\n```\n終わり';
  assert.equal(extractCodeBlocks(source), "say first\n\nsay second");
  assert.equal(extractCodeBlocks('```say inline```'), "say inline");
  assert.equal(extractCodeBlocks('```\n\n```'), "");
  assert.equal(extractCodeBlocks('説明 ```mcfunction\nsay unfinished'), "");
});

test("right click directly responds with extracted code and slash still opens a modal", () => {
  const response = handleInteraction({ type: 2, data: { type: 3, name: MESSAGE_COMMAND,
    target_id: "42", resolved: { messages: { 42: { content: "説明文\n```mcfunction\nsay hi\n```\n補足" } } } } }, ctx());
  assert.equal(response.type, 4);
  assert.equal(response.data.flags, 0);
  assert.equal(plain(response.data.content), "say hi");
  assert.equal(response.data.allowed_mentions.replied_user, false);
  // No explicit unsupported message_reference field: Discord adds target
  // attribution for the original message command response on the server.
  assert.equal(response.data.message_reference, undefined);
  const empty = handleInteraction(slash(), ctx());
  assert.equal(empty.type, 9);
  assert.equal(empty.data.components[0].component.value, undefined);
  assert.equal(empty.data.components[1].component.options[1].default, true);
  const privateModal = handleInteraction(slash([{ name: "private", value: true }]), ctx());
  assert.equal(privateModal.data.components[1].component.options[0].default, true);
});

test("nested Label modal fields become actual conversion arguments", () => {
  const response = handleInteraction({ type: 5, data: { custom_id: "mcfunction:convert",
    components: fields({ code: "# comment\n\nsay hi", visibility: "public", filter: "both", color: "basic" }) } }, ctx());
  assert.equal(response.type, 4);
  assert.equal(response.data.flags, 0);
  assert.equal(plain(response.data.content), "say hi");
  assert.deepEqual(response.data.allowed_mentions, { parse: [], replied_user: false });
});

test("public default, private opt-in, and external apps permission fallback", () => {
  const options = [{ name: "code", value: "say hi" }];
  assert.equal(handleInteraction(slash(options), ctx()).data.flags, 0);
  options.push({ name: "private", value: true });
  assert.equal(handleInteraction(slash(options), ctx()).data.flags, 64);
  options[1].value = false;
  assert.equal(handleInteraction(slash(options), ctx()).data.flags, 0);
  const guild = { ...slash(options), guild_id: "42", member: { permissions: "0" }, authorizing_integration_owners: { 1: "99" } };
  assert.equal(handleInteraction(guild, ctx()).data.flags, 64);
  guild.member.permissions = String(1n << 50n);
  assert.equal(handleInteraction(guild, ctx()).data.flags, 0);
});

test("rejects unavailable message bodies, oversized input and malformed modal settings", () => {
  const empty = handleInteraction({ type: 2, data: { type: 3, name: MESSAGE_COMMAND } }, ctx());
  assert.equal(empty.data.flags, 64);
  const noFence = handleInteraction({ type: 2, data: { type: 3, name: MESSAGE_COMMAND,
    target_id: "42", resolved: { messages: { 42: { content: "say hello" } } } } }, ctx());
  assert.equal(noFence.type, 4);
  assert.equal(noFence.data.flags, 64);
  assert.ok(noFence.data.content.includes("コードブロックがありません"));
  const big = handleInteraction(slash([{ name: "code", value: "a".repeat(4001) }]), ctx());
  assert.ok(big.data.content.includes("4,000"));
  const bad = handleInteraction({ type: 5, data: { custom_id: "mcfunction:convert", components: [] } }, ctx());
  assert.ok(bad.data.content.includes("不正"));
});

test("right-click long output uses the original interaction response before followups", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init, data: JSON.parse(init.body) });
    return Response.json({});
  });
  const code = ("execute as @a run say hello\n").repeat(30).trimEnd();
  const context = ctx();
  const interaction = { ...slash(), data: { type: 3, name: MESSAGE_COMMAND,
    target_id: "42", resolved: { messages: { 42: { content: "説明\n```mcfunction\n" + code + "\n```\n補足" } } } } };
  const response = handleInteraction(interaction, context);
  assert.equal(response.type, 5);
  assert.equal(response.data.flags, 0);
  await Promise.all(context.pending);
  assert.ok(calls[0].url.endsWith("/messages/@original"));
  assert.equal(calls[0].init.method, "PATCH");
  assert.ok(calls.slice(1).every(call => call.data.flags === 0));
  assert.equal(calls.map(call => plain(call.data.content)).join(""), plain(formatCode(code)));
});

test("long output ACKs and sends bounded webhook parts without bot credentials", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init, data: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  });
  const context = ctx();
  const code = ("execute as @a run say hello\n").repeat(30);
  const response = handleInteraction(slash([{ name: "code", value: code }]), context);
  assert.equal(response.type, 5);
  assert.equal(response.data.flags, 0);
  await Promise.all(context.pending);
  assert.ok(calls.length > 1 && calls.length <= 5);
  assert.equal(calls[0].init.method, "PATCH");
  assert.ok(calls.slice(1).every(call => call.init.method === "POST" && call.data.flags === 0));
  assert.equal(calls.map(call => plain(call.data.content)).join(""), plain(formatCode(code)));
  assert.ok(calls.every(call => call.data.content.length <= 2000 && !call.init.headers.Authorization));
  calls.length = 0;
  const privateContext = ctx();
  const privateResponse = handleInteraction(slash([{ name: "code", value: code }, { name: "private", value: true }]), privateContext);
  assert.equal(privateResponse.data.flags, 64);
  await Promise.all(privateContext.pending);
  assert.ok(calls.slice(1).every(call => call.data.flags === 64));
});

test("over five parts returns the complete ANSI output as a multipart file", async t => {
  let form;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    form = init.body;
    return new Response("{}", { status: 200 });
  });
  const context = ctx();
  const code = ('execute as @a[tag=foo,scores={foo=1..5}] run setblock ~ ~ ~ stone\n').repeat(50);
  assert.ok(code.length <= 4000);
  assert.ok(splitAnsi(formatCode(code)).length > 5);
  const response = handleInteraction(slash([{ name: "code", value: code }]), context);
  assert.equal(response.type, 5);
  await Promise.all(context.pending);
  assert.ok(form instanceof FormData);
  assert.equal(await form.get("files[0]").text(), formatCode(code));
  assert.equal(JSON.parse(form.get("payload_json")).attachments[0].filename, "mcfunction.ansi.txt");
});

test("background delivery retries rate limits and reports errors without leaking tokens", async t => {
  let calls = 0;
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args.join(" ")));
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? Response.json({ retry_after: 0 }, { status: 429 }) : Response.json({});
  });
  const context = ctx();
  const input = slash([{ name: "code", value: ('execute as @a run say hello\n').repeat(30) }]);
  handleInteraction(input, context);
  await Promise.all(context.pending);
  assert.ok(calls >= 3);
  assert.equal(logs.length, 0);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("https://example.invalid/test_token"); });
  const failed = ctx();
  handleInteraction(input, failed);
  await Promise.all(failed.pending);
  assert.equal(logs.length, 2);
  assert.ok(logs.every(log => !log.includes("test_token")));
});

test("HTTP signature verification accepts authentic raw bytes, rejects tampering and stale requests", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("hex");
  async function signed(body, timestamp = String(Math.floor(Date.now() / 1000))) {
    const signature = Buffer.from(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(timestamp + body))).toString("hex");
    return new Request("https://worker.test/interactions", { method: "POST", body,
      headers: { "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": signature } });
  }
  const env = { DISCORD_PUBLIC_KEY: publicKey };
  assert.deepEqual(await (await worker.fetch(await signed('{ "type": 1 }'), env, ctx())).json(), { type: 1 });
  const original = await signed('{"type":1}');
  const tampered = new Request(original.url, { method: "POST", headers: original.headers, body: '{"type":2}' });
  assert.equal((await worker.fetch(tampered, env, ctx())).status, 401);
  assert.equal((await worker.fetch(await signed('{"type":1}', "1"), env, ctx())).status, 401);
  assert.equal((await worker.fetch(await signed("{"), env, ctx())).status, 400);
  assert.equal((await worker.fetch(new Request(original.url, { method: "POST", body: '{}' }), env, ctx())).status, 401);
  assert.equal((await worker.fetch(await signed('{"type":1}'), {}, ctx())).status, 503);
  assert.equal((await worker.fetch(new Request("https://worker.test/interactions"), env, ctx())).status, 405);
  assert.equal((await worker.fetch(new Request("https://worker.test/missing"), env, ctx())).status, 404);
});
