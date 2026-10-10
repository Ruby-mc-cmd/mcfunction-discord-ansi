import highlighter from "../lib/highlight.js";

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const OPEN = "```ansi\n";
const CLOSE = "\n```";

export function extractCodeBlocks(source) {
  const blocks = [];
  for (const match of source.matchAll(/```([^]*?)```/g)) {
    let body = match[1];
    // Discord fences may begin with a language tag, or just a newline.
    body = body.replace(/^(?:[\w.+-]+[ \t]*)?\r?\n/, "");
    body = body.replace(/\r?\n$/, "");
    if (body.trim()) blocks.push(body);
  }
  return blocks.join("\n\n");
}

export function unwrapCode(source) {
  const text = source.trim();
  const fenced = text.match(/^```[^\n`]*\r?\n([\s\S]*?)\r?\n?```$/);
  // Remove incoming ANSI/control codes before generating our own.
  return (fenced ? fenced[1] : source)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function formatCode(source, options = {}) {
  const lines = highlighter.tokenize(unwrapCode(source), options);
  if (!lines.some(line => line.some(token => token.text.trim()))) {
    throw new Error("色付けするコードがありません。本文と除外設定を確認してください。");
  }
  return highlighter.toAnsi(lines, options.color ?? "truecolor");
}

// Split only between Unicode characters or complete escape sequences.
// Each part resets its terminal state and reopens the current color next time.
export function splitAnsi(ansi, limit = 2000) {
  const body = ansi.slice(OPEN.length, -CLOSE.length);
  const parts = [];
  let current = "", active = "";
  for (const unit of body.match(/\x1b\[[0-9;]*m|[^]/gu) ?? []) {
    if (OPEN.length + current.length + unit.length + RESET.length + CLOSE.length > limit) {
      parts.push(OPEN + current + RESET + CLOSE);
      current = active;
    }
    current += unit;
    if (unit.startsWith(ESC)) active = unit === RESET ? "" : unit;
  }
  if (current) parts.push(OPEN + current + RESET + CLOSE);
  return parts;
}
