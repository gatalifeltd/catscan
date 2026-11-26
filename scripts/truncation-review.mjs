// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 06 label review page (D43-D47, D55-D57): a local server on 127.0.0.1 that shows each gate screenshot with
// its line boxes and writes checked labels back to labels.json. No dependency, no network; images are read from
// <root> and never copied.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

export const CLASSES = ["ellipsis", "edge", "prefix"];
export const SECOND_SHARE = 0.2;
const DEFAULT_PORT = 4317;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * D71, D74: a stored box grown by `px` rendered pixels on each side, for an image drawn `w` x `h` pixels; unchanged
 * before the image has a size. The page script embeds this function.
 */
export function outset(b, w, h, px = 4) {
  const ox = w ? px / w : 0, oy = h ? px / h : 0;
  return [b[0] - ox, b[1] - oy, b[2] + 2 * ox, b[3] + 2 * oy];
}

/**
 * D46: the second-review sample. Checked images ranked by SHA-256 of their path; already reviewed ones count
 * toward ceil(20%) of the checked images, and the lowest-ranked unreviewed ones fill the rest.
 */
export function secondSample(images, labels) {
  const checked = images.filter((i) => labels[i]?.status === "checked").sort((a, b) => (sha(a) < sha(b) ? -1 : 1));
  const quota = Math.ceil(SECOND_SHARE * checked.length);
  const reviewed = checked.filter((i) => labels[i].reviewed_by);
  const todo = checked.filter((i) => !labels[i].reviewed_by).slice(0, Math.max(0, quota - reviewed.length));
  return { quota, reviewed, todo };
}

/** The label lines a save may write; throws an Error naming the first bad field. */
export function checkLines(lines) {
  if (!Array.isArray(lines)) throw new Error("lines must be an array");
  return lines.map((l, i) => {
    const at = `lines[${i}]`;
    if (!l || typeof l !== "object") throw new Error(`${at} must be an object`);
    const b = l.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => typeof v === "number" && v >= 0 && v <= 1) || !(b[2] > 0) || !(b[3] > 0)) {
      throw new Error(`${at}.box must be 4 numbers in 0..1 with width and height above 0`);
    }
    if (l.line !== null && typeof l.line !== "string") throw new Error(`${at}.line must be a string or null`);
    if (typeof l.truncated !== "boolean") throw new Error(`${at}.truncated must be true or false`);
    if (l.truncated && !CLASSES.includes(l.class)) throw new Error(`${at}.class must be ${CLASSES.join(", ")} on a truncated line`);
    if (l.rule !== null && l.rule !== undefined && typeof l.rule !== "string") throw new Error(`${at}.rule must be a string or null`);
    const out = { line: l.line, box: b, truncated: l.truncated, class: l.truncated ? l.class : null, rule: l.rule ?? null };
    if (l.manual) out.manual = true;
    return out;
  });
}

/**
 * The entry a save writes (D45, D57). The server, not the page, sets status and names: a first check records
 * `checked_by`; a second review keeps `checked_by` and records `reviewed_by`, which must be someone else.
 */
export function savedEntry(old, lines, by, second) {
  if (typeof by !== "string" || !by.trim()) throw new Error("a reviewer name is needed");
  if (!old) throw new Error("this image has no draft labels; run draft first");
  const checked = checkLines(lines);
  if (!second) return { status: "checked", checked_by: by.trim(), reviewed_by: old.reviewed_by ?? null, lines: checked };
  if (old.status !== "checked") throw new Error("only a checked image gets a second review");
  if (old.checked_by === by.trim()) throw new Error(`the second review needs someone other than ${old.checked_by}`);
  return { status: "checked", checked_by: old.checked_by, reviewed_by: by.trim(), lines: checked };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** D47: a copy of labels.json next to it, before the first rewrite of a run. */
export function backup(file) {
  if (!fs.existsSync(file)) return null;
  const to = `${file}.bak-${stamp()}`;
  fs.copyFileSync(file, to);
  return to;
}

/** Atomic: a temp file in the same folder, renamed over labels.json. */
export function writeJson(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function readState(root) {
  const need = (f) => {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) {
      const e = new Error(`${p} is missing; run: node scripts/truncation-labels.mjs manifest ${root} && node scripts/truncation-labels.mjs draft ${root}`);
      e.code = "missing-labels";
      throw e;
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  };
  const { screens } = need("manifest.json");
  return { screens, labels: need("labels.json") };
}

/** Starts the server; resolves to { server, url, port }. */
export function startServer({ root, port = DEFAULT_PORT, by = null, second = false, tries = 20 } = {}) {
  root = path.resolve(root);
  readState(root); // fail before listening when manifest or labels are missing (D55)
  const realRoot = fs.realpathSync(root);
  const token = crypto.randomBytes(16).toString("hex");
  const file = path.join(root, "labels.json");
  let backedUp = null;
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    const json = (code, o) => send(code, "application/json", JSON.stringify(o));
    // DNS rebinding: only this machine's names for this port.
    const p = server.address().port;
    if (![`127.0.0.1:${p}`, `localhost:${p}`].includes(req.headers.host)) return json(403, { error: "wrong host" });
    const url = new URL(req.url, `http://127.0.0.1:${p}`);
    let state;
    try { state = readState(root); } catch (e) { return json(500, { error: e.message }); }
    const screen = () => state.screens[Number(url.searchParams.get("i"))];
    if (req.method === "GET" && url.pathname === "/") return send(200, "text/html; charset=utf-8", page(token));
    if (req.method === "GET" && url.pathname === "/api/state") {
      const images = state.screens.map((s) => s.image);
      return json(200, { screens: state.screens.map(({ image, app, locale, screen: name }) => ({ image, app, locale, screen: name })), labels: state.labels, by, second, sample: second ? secondSample(images, state.labels) : null });
    }
    if (req.method === "GET" && (url.pathname === "/img" || url.pathname === "/boxes")) {
      const s = screen();
      if (!s) return json(404, { error: "no such image" });
      const f = path.join(root, url.pathname === "/img" ? s.image : s.image.replace(/\.png$/, ".boxes.json"));
      // Real paths, so a symlinked folder cannot serve a file outside the dataset.
      const real = fs.existsSync(f) ? fs.realpathSync(f) : null;
      if (!real || !real.startsWith(realRoot + path.sep)) return url.pathname === "/boxes" ? json(200, { elements: [] }) : json(404, { error: "no such image" });
      res.writeHead(200, { "content-type": url.pathname === "/img" ? "image/png" : "application/json", "cache-control": "no-store" });
      return fs.createReadStream(real).pipe(res);
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      if (req.headers["x-token"] !== token) return json(403, { error: "bad token; reload the page" });
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4e6) req.destroy(); });
      req.on("end", () => {
        try {
          const o = JSON.parse(body);
          const s = state.screens[o.i];
          if (!s) throw new Error("no such image");
          const entry = savedEntry(state.labels[s.image], o.lines, o.by, second);
          // Read again right before writing, so a draft run in between keeps its other images.
          const labels = JSON.parse(fs.readFileSync(file, "utf8"));
          labels[s.image] = entry;
          if (!backedUp) backedUp = backup(file);
          writeJson(file, labels);
          json(200, { entry });
        } catch (e) {
          json(400, { error: e.message });
        }
      });
      return;
    }
    json(404, { error: "not found" });
  });
  return new Promise((resolve, reject) => {
    let left = tries;
    const listen = (n) => {
      server.once("error", (e) => (e.code === "EADDRINUSE" && --left > 0 && n ? listen(n + 1) : reject(e)));
      server.listen(n, "127.0.0.1", () => {
        const a = server.address().port;
        resolve({ server, port: a, url: `http://127.0.0.1:${a}/`, backup: () => backedUp });
      });
    };
    listen(port);
  });
}

function page(token) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Truncation labels</title>
<style>
:root{--bg:#f6f6f4;--fg:#1d1d1f;--muted:#6e6e73;--line:#8e8e93;--cut:#e0201b;--sel:#f5a400;--el:#2f6fdb;--panel:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161617;--fg:#f2f2f2;--muted:#a1a1a6;--line:#8e8e93;--cut:#ff453a;--sel:#ffd60a;--el:#64a0ff;--panel:#1f1f21}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 -apple-system,system-ui,sans-serif;display:flex;height:100vh}
#shot{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:12px}
#wrap{position:relative;display:inline-block;max-height:calc(100vh - 24px)}
#img{display:block;max-height:calc(100vh - 24px);max-width:100%;user-select:none}
svg{position:absolute;inset:0;width:100%;height:100%;cursor:crosshair}
rect{fill:transparent;vector-effect:non-scaling-stroke;stroke-width:1;stroke-opacity:.6;cursor:pointer}
rect.v{pointer-events:none}rect.hit{stroke:none}rect.l{stroke:var(--line)}rect.t{stroke:var(--cut);fill:rgba(224,32,27,.06)}rect.s{stroke:var(--sel);stroke-width:2;stroke-opacity:.9}
rect.e{stroke:var(--el);stroke-dasharray:4 3;pointer-events:none}rect.d{stroke:var(--sel);stroke-dasharray:3 2;pointer-events:none}
#side{width:380px;background:var(--panel);border-left:1px solid #8883;display:flex;flex-direction:column}
header{padding:10px 12px;border-bottom:1px solid #8883}header b{font-size:15px}.muted{color:var(--muted)}
#who{cursor:pointer;text-decoration:underline dotted}
#lines{flex:1;overflow:auto;margin:0;padding:0;list-style:none}
#lines li{padding:6px 12px;border-bottom:1px solid #8882;cursor:pointer}#lines li.s{background:#f5a40022}
#lines li.t .txt{color:var(--cut);font-weight:600}.tag{font-size:12px;color:var(--muted);margin-left:6px}
#msg{padding:8px 12px;min-height:2.4em;border-top:1px solid #8883}#msg.err{color:var(--cut)}
#help{padding:8px 12px;font-size:12px;color:var(--muted);border-top:1px solid #8883;display:none}#help.on{display:block}
kbd{font:12px ui-monospace,monospace;border:1px solid #8886;border-radius:3px;padding:0 3px}
</style></head><body>
<div id="shot"><div id="wrap"><img id="img" alt="screenshot"><svg id="svg" viewBox="0 0 1 1" preserveAspectRatio="none"></svg></div></div>
<aside id="side"><header><div><b id="title"></b></div><div class="muted" id="prog"></div><div class="muted">by <span id="who"></span></div></header>
<ul id="lines"></ul><div id="msg"></div>
<div id="help"><kbd>j</kbd>/<kbd>k</kbd> line, <kbd>f</kbd> next truncated, <kbd>y</kbd> truncated, <kbd>x</kbd> not truncated,
<kbd>1</kbd> ellipsis <kbd>2</kbd> edge <kbd>3</kbd> prefix, <kbd>u</kbd> undo, <kbd>n</kbd>/<kbd>p</kbd> image, <kbd>Enter</kbd> save as checked,
<kbd>b</kbd> element boxes, <kbd>h</kbd> hide all boxes, <kbd>?</kbd> keys. Click a line to select it (an unflagged one becomes truncated); drag on empty space to add a line Vision missed.</div></aside>
<script>
const TOKEN=${JSON.stringify(token)};
const outset=${outset.toString()};
const $=(id)=>document.getElementById(id);
const CLS={1:"ellipsis",2:"edge",3:"prefix"};
const fromRule=(r)=>r==="ellipsis"?"ellipsis":r==="prefix"?"prefix":r?"edge":null;
let S,order=[],at=0,sel=0,edits={},showEl=false,bare=false,els=null,drag=null,name=null;
const store={get(){try{return localStorage.getItem("catscan-review-name")}catch{return null}},set(v){try{localStorage.setItem("catscan-review-name",v)}catch{}}};
function img(){return S.screens[order[at]].image}
function cur(){const i=img();if(!edits[i])edits[i]={lines:structuredClone(S.labels[i]?.lines||[]),undo:[],dirty:false};return edits[i]}
function msg(t,err){$("msg").textContent=t||"";$("msg").className=err?"err":""}
function change(f){const e=cur();e.undo.push(structuredClone(e.lines));f(e.lines);e.dirty=true;draw()}
function askName(){const v=prompt("Your name, recorded as "+(S.second?"reviewed_by":"checked_by"),name||"");if(v&&v.trim()){name=v.trim();store.set(name)}draw()}
async function load(){
  S=await (await fetch("/api/state")).json();
  name=S.by||store.get();
  order=S.second?[...S.sample.todo,...S.sample.reviewed].map((p)=>S.screens.findIndex((s)=>s.image===p)):S.screens.map((_,i)=>i);
  if(!S.second){const u=order.findIndex((i)=>S.labels[S.screens[i].image]?.status!=="checked");at=u<0?0:u}
  if(!order.length){msg(S.second?"No checked images to review yet.":"No images in manifest.json.",true);return}
  if(!name)askName();show();
}
function show(){sel=0;els=null;const i=order[at];$("img").src="/img?i="+i;if(showEl)fetch("/boxes?i="+i).then((r)=>r.json()).then((b)=>{els=b.elements||[];draw()});draw()}
function draw(){
  const e=cur(),lab=S.labels[img()]||{},s=S.screens[order[at]];
  $("title").textContent=s.image;
  const unchecked=S.screens.filter((x)=>S.labels[x.image]?.status!=="checked").length;
  $("prog").textContent=(at+1)+" of "+order.length+(S.second?" in the 20% sample (quota "+S.sample.quota+")":"")+" - "+unchecked+" unchecked - "+(lab.status||"no labels")+(lab.checked_by?" by "+lab.checked_by:"")+(lab.reviewed_by?", reviewed by "+lab.reviewed_by:"")+(e.dirty?" - unsaved":"")+(bare?" - overlays hidden (h)":"");
  $("who").textContent=name||"(click to set)";
  const svg=$("svg");svg.innerHTML="";
  const R=(b,c,k)=>{const r=document.createElementNS("http://www.w3.org/2000/svg","rect");r.setAttribute("x",b[0]);r.setAttribute("y",b[1]);r.setAttribute("width",b[2]);r.setAttribute("height",b[3]);r.setAttribute("class",c);if(k!==undefined)r.dataset.k=k;svg.appendChild(r);return r};
  // D71, D74: drawn 4 screen pixels outside the stored box, so a stroke never covers a glyph's top; the image's load
  // event draws again once it has a size. Clicks hit the stored box, so outset strokes of close lines never steal one,
  // and with overlays hidden (h) a click still selects a line instead of drawing a duplicate.
  const box=svg.getBoundingClientRect(),O=(b)=>outset(b,box.width,box.height);
  if(!bare){
    if(showEl&&els)for(const x of els)R(O(x.box),"e");
    e.lines.forEach((l,k)=>R(O(l.box),"v "+(l.truncated?"t":"l")+(k===sel?" s":"")));
  }
  e.lines.forEach((l,k)=>R(l.box,"hit",k));
  if(drag&&drag.b)R(drag.b,"d");
  const ul=$("lines");ul.innerHTML="";
  e.lines.forEach((l,k)=>{const li=document.createElement("li");li.className=(l.truncated?"t":"")+(k===sel?" s":"");
    const t=document.createElement("span");t.className="txt";t.textContent=l.line??"(drawn box)";li.appendChild(t);
    const g=document.createElement("span");g.className="tag";g.textContent=[l.truncated?(CLS_OK(l.class)?l.class:l.class==="clip"?"clip, pick a class":"pick a class"):"",l.rule?"rule "+l.rule:""].filter(Boolean).join(" - ");li.appendChild(g);
    li.onclick=()=>{sel=k;draw()};ul.appendChild(li)});
  const li=ul.children[sel];if(li)li.scrollIntoView({block:"nearest"});
}
const CLS_OK=(c)=>["ellipsis","edge","prefix"].includes(c);
function go(d){at=(at+d+order.length)%order.length;show()}
async function save(){
  const e=cur(),bad=e.lines.findIndex((l)=>l.truncated&&!CLS_OK(l.class));
  if(!name){askName();return}
  if(bad>=0){sel=bad;draw();msg("Pick a class (1 ellipsis, 2 edge, 3 prefix) for every truncated line.",true);return}
  const lab=S.labels[img()];
  if(S.second&&lab?.checked_by===name){msg("The second review needs someone other than "+name+".",true);return}
  const r=await fetch("/api/save",{method:"POST",headers:{"content-type":"application/json","x-token":TOKEN},body:JSON.stringify({i:order[at],lines:e.lines,by:name})});
  const o=await r.json();if(!r.ok){msg(o.error,true);return}
  S.labels[img()]=o.entry;delete edits[img()];msg("Saved "+img()+".");
  if(S.second){if(at<order.length-1)go(1);else draw();return}
  for(let k=1;k<=order.length;k++){const j=(at+k)%order.length;if(S.labels[S.screens[order[j]].image]?.status!=="checked"){at=j;show();return}}
  msg("Saved. Every image is checked.");draw();
}
document.addEventListener("keydown",(ev)=>{
  if(ev.metaKey||ev.ctrlKey||ev.altKey)return;
  const e=cur(),n=e.lines.length,k=ev.key;
  if(k==="j"||k==="ArrowDown"){sel=n?(sel+1)%n:0;draw()}
  else if(k==="k"||k==="ArrowUp"){sel=n?(sel-1+n)%n:0;draw()}
  else if(k==="f"){for(let d=1;d<=n;d++){const j=(sel+d)%n;if(e.lines[j].truncated){sel=j;break}}draw()}
  else if(k==="y"&&n)change((L)=>{L[sel].truncated=true;if(!CLS_OK(L[sel].class))L[sel].class=fromRule(L[sel].rule)})
  else if(k==="x"&&n)change((L)=>{L[sel].truncated=false;L[sel].class=null})
  else if(CLS[k]&&n)change((L)=>{L[sel].truncated=true;L[sel].class=CLS[k]})
  else if(k==="u"){if(e.undo.length){e.lines=e.undo.pop();e.dirty=e.undo.length>0;draw()}}
  else if(k==="n"||k==="ArrowRight")go(1)
  else if(k==="p"||k==="ArrowLeft")go(-1)
  else if(k==="Enter")save()
  else if(k==="b"){showEl=!showEl;show()}
  else if(k==="h"){bare=!bare;draw()}
  else if(k==="?")$("help").classList.toggle("on")
  else return;
  ev.preventDefault();
});
const pt=(ev)=>{const r=$("svg").getBoundingClientRect();return[Math.min(1,Math.max(0,(ev.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(ev.clientY-r.top)/r.height))]};
$("svg").addEventListener("mousedown",(ev)=>{
  const k=ev.target.dataset?.k;
  if(k!==undefined){sel=+k;if(!cur().lines[sel].truncated)change((L)=>{L[sel].truncated=true;L[sel].class=null;});else draw();msg(cur().lines[sel].truncated&&!CLS_OK(cur().lines[sel].class)?"Marked truncated: pick a class with 1, 2 or 3.":"");return}
  drag={a:pt(ev),b:null};
});
addEventListener("mousemove",(ev)=>{if(!drag)return;const[a,b]=[drag.a,pt(ev)];drag.b=[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1])];draw()});
addEventListener("mouseup",()=>{if(!drag)return;const b=drag.b;drag=null;
  if(b&&b[2]>0.005&&b[3]>0.003){change((L)=>{L.push({line:null,box:b.map((v)=>Math.round(v*1e4)/1e4),truncated:true,class:null,rule:null,manual:true})});sel=cur().lines.length-1;msg("Added a missed line: pick a class with 1, 2 or 3.");draw()}else draw()});
$("who").onclick=askName;
$("img").addEventListener("load",()=>draw());addEventListener("resize",()=>{if(S)draw()});
addEventListener("beforeunload",(ev)=>{if(Object.values(edits).some((e)=>e.dirty)){ev.preventDefault();ev.returnValue=""}});
load().catch((e)=>msg(String(e),true));
</script></body></html>`;
}
