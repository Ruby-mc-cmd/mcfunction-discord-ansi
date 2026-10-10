(function(root, factory){
  if(typeof module === "object" && module.exports) module.exports = factory();
  else root.McfunctionAnsi = factory();
})(globalThis, function(){
"use strict";
const ESC = "\u001b";
/* VS Code（Dark Modern + Spyglass）の色。スクリーンショットから読み取った値。
   fb は 24bit 非対応の Discord で代わりに使う8色のコード */
const col = (() => {
  const cache = {};
  // 未対応の Discord は 38;2;R;G;B の数字を1つずつ解釈するので、R/G/B が既存のコードと重なる値は少しずらす
  const risky = v => v <= 9 || (v >= 21 && v <= 55) || (v >= 90 && v <= 97) || (v >= 100 && v <= 107);
  const safe = v => { let d = 0; while(risky(v + d) || v + d > 255 || v + d < 0) d = d > 0 ? -d : -d + 1; return v + d; };
  return (hex, fb) => cache[hex + fb] ||= {hex, fb, rgb:[1,3,5].map(i => safe(parseInt(hex.slice(i,i+2),16))).join(";")};
})();
const PALETTE = {
  command:  col("#C586C0",35),
  literal:  col("#569CD6",34),
  selector: col("#569CD6",34),
  variable: col("#9CDCFE",36),
  key:      col("#9CDCFE",36),
  resource: col("#DCDCAA",33),
  number:   col("#B5CEA8",32),
  string:   col("#CE9178",31),
  comment:  col("#6A9955",32),
  br1:      col("#FFD700",33),
  br2:      col("#DA70D6",35),
  br3:      col("#179FFF",34),
  macro:    col("#569CD6",34),
  macrovar: col("#9CDCFE",36),
  macrobody:col("#CE9178",31),
};

const LITERALS = new Set(`as at positioned rotated facing align anchored in if unless store result success run on summon matches entity block blocks score data predicate function dimension biome loaded items eyes feet over origin attacker controller leasher owner passengers target vehicle all masked
add remove set get reset list enable operation objectives players display sidebar belowname numberformat rendertype modify displayname setdisplay
merge append prepend insert value from string storage replace destroy keep hollow outline fill filtered normal force strict
with infinite hide true false join leave empty members grant revoke everything only through until
start stop query time day night noon midnight daytime gametime weather clear rain thunder
title subtitle actionbar times give effect levels points
fail clone filter slot contents container
max visible color style progress
option friendlyFire collisionRule seeFriendlyInvisibles
master music record ambient hostile neutral voice block player
byte short int long float double by`.split(/\s+/));
const EXEC_SUBS = new Set("as at positioned rotated facing align anchored in if unless store on summon".split(" "));
const CMD_PENDING = {
  give:["target","resource"], clear:["target","resource"], summon:["resource"],
  setblock:["pos","pos","pos","resource"], fill:["pos","pos","pos","pos","pos","pos","resource"],
  particle:["resource"], playsound:["resource"], function:["resource"],
  enchant:["target","resource"], attribute:["target","resource"], trigger:["objective"],
};
const GREEDY = {say:0, me:0, teammsg:0, tm:0, msg:1, tell:1, w:1};

/* ---------- tokenizer ---------- */
const NUM = /^(?:[~^](?:-?(?:\d+\.?\d*|\.\d+))?|-?(?:\d+\.?\d*|\.\d+)(?:\.\.(?:-?(?:\d+\.?\d*|\.\d+))?)?|\.\.-?(?:\d+\.?\d*|\.\d+))[bBsSlLfFdDt]?(?![A-Za-z0-9_:.\/])/;
const RES = /^#?[a-z0-9_.\-]+:[a-z0-9_.\-\/]+(?![A-Za-z0-9_])/;
const KEY = /^[A-Za-z0-9_.+\-]+(?::[a-z0-9_.\/\-]+)?(?=\s*[:=])/;
const STR = /^"(?:[^"\\]|\\.)*"?|^'(?:[^'\\]|\\.)*'?/;
const OP  = /^(?:[+\-*\/%]?=|><|[<>]=?)(?=\s|$)/;
const OPEN = "[{(", CLOSE = "]})", PAIR = {"]":"[", "}":"{", ")":"("};
const brType = lvl => "br" + (((lvl - 1) % 3) + 1);

function tokenizeLine(line){
  const out = [];
  const push = (text,type) => { if(text) out.push({text,type}); };
  const lead = line.match(/^\s*/)[0];
  push(lead,null);
  const i = lead.length;
  if(line[i] === "#"){ push(line.slice(i),"comment"); return out; }
  if(line[i] === "$") tokenizeMacro(line, i, push);
  else tokenizeCommand(line, i, push, out);
  return out;
}

/* マクロ行: VS Code では $ と括弧とマクロ変数以外が文字列色になる */
function tokenizeMacro(line, i, push){
  const stack = [];
  push("$","macro"); i++;
  while(i < line.length){
    const s = line.slice(i); let m;
    if((m = s.match(/^\$\(([A-Za-z0-9_]*)/))){
      push("$","macro"); stack.push("("); push("(", brType(stack.length)); push(m[1],"macrovar");
      i += m[0].length; continue;
    }
    if(OPEN.includes(s[0])){ stack.push(s[0]); push(s[0], brType(stack.length)); i++; continue; }
    if(CLOSE.includes(s[0])){
      if(stack.length && stack[stack.length-1] === PAIR[s[0]]){ push(s[0], brType(stack.length)); stack.pop(); }
      else push(s[0],"macrobody");
      i++; continue;
    }
    m = s.match(/^\s+/) || s.match(/^[^\s\[\]{}()$]+/) || [s[0]];
    push(m[0], /^\s+$/.test(m[0]) ? null : "macrobody");
    i += m[0].length;
  }
}

function tokenizeCommand(line, i, push, out){
  const stack = [];          // bracket frames
  let expectCmd = true, cmd = null, pending = [], dataCtx = false, scoreCmp = false;
  let pathMode = false, greedy = false, prevType = null, prevLit = null;
  const top = () => stack[stack.length-1];
  const lastText = () => { for(let k=out.length-1;k>=0;k--) return out[k].text; return ""; };
  const lastType = () => out.length ? out[out.length-1].type : null;

  const resetChain = () => { pending = []; dataCtx = false; scoreCmp = false; };
  const onLiteral = w => {
    if(cmd === "execute" && EXEC_SUBS.has(w)) resetChain();
    switch(w){
      case "data": case "store": case "from": case "with": dataCtx = true; break;
      case "storage": pending = ["resource","path"]; break;
      case "entity": if(dataCtx) pending = ["target","path"]; break;
      case "block": pending = dataCtx ? ["pos","pos","pos","path"] : ["pos","pos","pos","resource"]; break;
      case "score": pending = ["holder","objective"]; scoreCmp = (prevLit === "if" || prevLit === "unless"); break;
      case "matches": scoreCmp = false; break;
      case "predicate": case "dimension": case "in": case "function": pending = ["resource"]; break;
      case "summon": if(cmd === "execute") pending = ["resource"]; break;
      case "biome": pending = ["pos","pos","pos","resource"]; break;
      case "operation": if(cmd === "scoreboard") pending = ["holder","objective","op","holder","objective"]; break;
      case "list": if(cmd === "scoreboard" && prevLit === "players") pending = ["holder"]; break;
      case "setdisplay": pending = ["slot","objective"]; break;
      case "replace": if(cmd === "fill") pending = ["resource"]; break;
      case "join": case "empty": if(cmd === "team") pending = ["name"]; break;
      case "give": case "clear": if(cmd === "effect") pending = ["target","resource"]; break;
      case "modify":
        if(cmd === "scoreboard") pending = ["objective"];
        else if(cmd === "team") pending = ["name"];
        break;
      case "set": case "add": case "remove": case "get": case "reset": case "enable":
        if(cmd === "scoreboard" && prevLit === "players") pending = ["holder","objective"];
        else if(cmd === "scoreboard" && prevLit === "objectives") pending = w === "add" ? ["objective","criteria"] : ["objective"];
        else if((cmd === "tag" || cmd === "team") && (w === "add" || w === "remove")) pending = ["name"];
        break;
    }
    prevLit = w;
  };
  const emit = (text,type) => {
    push(text,type);
    if(!stack.length && !/^\s+$/.test(text)) prevType = type;
  };
  // NBT パス: 区切りの . は色なし、名前部分はキー色
  const emitPath = w => w.split(/(\.)/).forEach(p => push(p, p === "." ? null : "key"));

  while(i < line.length){
    const s = line.slice(i); let m;
    if((m = s.match(/^\s+/))){ push(m[0],null); i += m[0].length; if(!stack.length) pathMode = false; continue; }
    const f = top();

    /* --- 括弧 --- */
    if(OPEN.includes(s[0])){
      const adj = out.length && !/^\s+$/.test(lastText());
      let kind = "list";
      if(s[0] === "{") kind = "compound";
      else if(s[0] === "(") kind = "paren";
      else if(pathMode) kind = "index";
      else if(adj && lastType() === "selector") kind = "selector";
      else if(adj && lastType() === "resource") kind = "state";
      if(!stack.length && pending[0] === "path"){ pending.shift(); pathMode = true; }
      stack.push({ch:s[0], kind, keys: kind === "compound" || kind === "selector" || kind === "state", expectKey:true, lastKey:null});
      push(s[0], brType(stack.length)); i++; expectCmd = false; continue;
    }
    if(CLOSE.includes(s[0])){
      if(f && f.ch === PAIR[s[0]]){ push(s[0], brType(stack.length)); stack.pop(); }
      else push(s[0], null);
      i++; continue;
    }

    /* --- 括弧の中（セレクター引数・NBT・JSON・ブロック状態） --- */
    if(f){
      if(s[0] === ","){ push(",",null); i++; if(f.keys) f.expectKey = true; continue; }
      if(s[0] === "=" || s[0] === ":"){ push(s[0],null); i++; f.expectKey = false; continue; }
      if(s[0] === ";"){ push(";",null); i++; continue; }
      if(s[0] === "!"){ push("!","operator"); i++; continue; }
      if((m = s.match(STR))){
        const isKey = f.keys && f.expectKey && /^\s*[:=]/.test(s.slice(m[0].length));
        if(isKey){ f.expectKey = false; f.lastKey = m[0]; }
        push(m[0], isKey ? "key" : "string"); i += m[0].length; continue;
      }
      if(f.keys && f.expectKey && (m = s.match(KEY))){
        f.expectKey = false; f.lastKey = m[0];
        push(m[0], m[0].includes(":") ? "resource" : "key"); i += m[0].length; continue;
      }
      if((m = s.match(NUM))){ push(m[0],"number"); i += m[0].length; continue; }
      if((m = s.match(RES))){ push(m[0],"resource"); i += m[0].length; continue; }
      if((m = s.match(/^[^\s{}\[\]()",':=;!]+/))){
        const w = m[0]; let type = null;
        if(f.kind === "selector" && (f.lastKey === "tag" || f.lastKey === "team")) type = "variable";
        else if(f.kind === "selector" && (f.lastKey === "type" || f.lastKey === "predicate")) type = "resource";
        else if(w === "true" || w === "false") type = "literal";
        else if(f.kind === "index" && pathMode) type = "key";
        push(w,type); i += w.length; continue;
      }
      push(s[0],null); i++; continue;
    }

    /* --- 括弧の外 --- */
    // 文字列
    if((m = s.match(STR))){
      if(pending[0] === "path"){ pending.shift(); pathMode = true; }
      if(pathMode) push(m[0],"key");
      else { if(pending.length) pending.shift(); emit(m[0],"string"); }
      i += m[0].length; expectCmd = false; continue;
    }
    // セレクター
    if((m = s.match(/^@[aenprs](?![A-Za-z0-9_])/))){
      if(pending[0] === "holder" || pending[0] === "target"){ pending.shift(); if(cmd in GREEDY && !pending.length) greedy = true; }
      emit(m[0],"selector"); i += m[0].length; expectCmd = false; continue;
    }
    // 演算子（scoreboard operation / execute if score の比較）
    if((m = s.match(OP)) && !expectCmd){
      if(pending[0] === "op") pending.shift();
      if(scoreCmp){ pending = ["holder","objective"]; scoreCmp = false; }
      emit(m[0],"operator"); i += m[0].length; continue;
    }
    // 単語
    m = s.match(/^[^\s{}\[\]()",']+/);
    if(!m){ push(s[0],null); i++; continue; }
    const w = m[0];
    i += w.length;

    if(greedy){ emit(w,null); continue; }
    if(w === "run" && !expectCmd && !pending.length){
      emit(w,"literal"); expectCmd = true; cmd = null; resetChain(); prevLit = "run"; continue;
    }
    if(expectCmd){
      emit(w,"command"); expectCmd = false; cmd = w; prevLit = null;
      pending = (CMD_PENDING[w] || []).slice();
      if(w === "data") dataCtx = true;
      if(w in GREEDY){ pending = GREEDY[w] ? ["target"] : []; greedy = !GREEDY[w]; }
      continue;
    }
    if(pending.length){
      const kind = pending.shift();
      if(kind === "path"){ pathMode = true; emitPath(w); continue; }
      if(kind === "op"){ emit(w,"operator"); continue; }
      if(kind === "pos"){ emit(w, NUM.test(w) ? "number" : null); continue; }
      if(kind === "resource"){ emit(w,"resource"); continue; }
      if(kind === "slot"){ emit(w,"literal"); continue; }
      emit(w,"variable");                 // holder / objective / criteria / name / target
      if(cmd in GREEDY && !pending.length) greedy = true;
      continue;
    }
    if(pathMode){ emitPath(w); continue; }
    if(RES.test(w) && w.match(RES)[0] === w){ emit(w,"resource"); continue; }
    if(NUM.test(w) && w.match(NUM)[0] === w){ emit(w,"number"); continue; }
    if(w[0] === "#"){ emit(w,"variable"); continue; }
    if(w === "true" || w === "false"){ emit(w,"literal"); continue; }
    if(LITERALS.has(w)){ emit(w,"literal"); onLiteral(w); continue; }
    if(prevType === "selector" || prevType === "variable"){ emit(w,"variable"); continue; }
    if(/^[A-Za-z_][\w]*(\.[\w]+)+$/.test(w)){ emitPath(w); continue; }
    emit(w,null);
  }
}

function tokenize(src, opt = {}){
  let lines = src.replace(/\r\n?/g,"\n").replace(/\t/g,"    ").split("\n");
  if(opt.noComments) lines = lines.filter(l => !/^\s*#/.test(l));
  if(opt.noBlank) lines = lines.filter(l => l.trim()!=="");
  while(lines.length && lines[lines.length-1].trim()==="") lines.pop();
  return lines.map(tokenizeLine);
}

/* ---------- output ---------- */
// 1つの指定に 8色（24bit 未対応の Discord 用）と 24bit（VS Code の色）を続けて書く
function toAnsi(lines, colorMode = "truecolor"){
  let out = "", cur = null;
  for(let li=0; li<lines.length; li++){
    for(const tok of lines[li]){
      const text = tok.text.replace(/```/g, "`\u200b``");
      if(/^\s+$/.test(text)){ out += text; continue; }
      const c = PALETTE[tok.type] || null;
      if(c !== cur){
        out += c ? (colorMode === "basic" ? `${ESC}[0;${c.fb}m` : `${ESC}[0;${c.fb};38;2;${c.rgb}m`) : `${ESC}[0m`;
        cur = c;
      }
      out += text;
    }
    if(li < lines.length-1) out += "\n";
  }
  if(cur) out += `${ESC}[0m`;
  return "```ansi\n" + out + "\n```";
}

function toHtml(lines){
  const esc = t => t.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
  return lines.map(toks => toks.map(tok => {
    const c = PALETTE[tok.type];
    return c ? `<span style="color:${c.hex}">${esc(tok.text)}</span>` : esc(tok.text);
  }).join("")).join("\n");
}


return {tokenize, tokenizeLine, toAnsi, toHtml};
});
