// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-046 game export path: spec 12's game captures (from a capture script that is not published) carry every drawn text's
// rect in screenshot px (`texts_px`, from the game's `__nv.texts()`); this writes them as a `--boxes` sidecar per
// screen, one text element per drawn text with id `t<index>`. The capture has no graphic leaves, so the set checks
// text-text only.
// Usage: node bench/overlap/games-to-boxes.mjs <datasets/overlap-games> <outdir>  (mirrors <app>/<locale>/<screen>)
import fs from "node:fs";
import path from "node:path";

const round4 = (v) => Math.round(v * 10000) / 10000;

export function toBoxes(side) {
  const { width: W, height: H } = side.image;
  const elements = [];
  for (const t of side.texts_px) {
    const r = t.rect;
    const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(W, r.x + r.width), y1 = Math.min(H, r.y + r.height);
    if (x1 <= x0 || y1 <= y0) continue;
    const e = { id: `t${t.index}`, box: [x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H].map(round4), clips: false, text: t.text };
    if (r.x < 0 || r.y < 0 || r.x + r.width > W || r.y + r.height > H) e.offscreen = true;
    if (e.box[2] > 0 && e.box[3] > 0) elements.push(e);
  }
  return { image: { width: W, height: H }, elements };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root, out] = process.argv.slice(2);
  let n = 0;
  for (const app of fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "manifest.json")))) {
    for (const locale of fs.readdirSync(path.join(root, app)).filter((d) => fs.statSync(path.join(root, app, d)).isDirectory())) {
      const dir = path.join(root, app, locale), to = path.join(out, app, locale);
      fs.mkdirSync(to, { recursive: true });
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        fs.writeFileSync(path.join(to, f.replace(/\.json$/, ".boxes.json")), JSON.stringify(toBoxes(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))));
        n++;
      }
    }
  }
  process.stderr.write(`games-to-boxes: ${n} sidecars in ${out}\n`);
}
