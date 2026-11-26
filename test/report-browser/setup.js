// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// Builds the reports the browser tests open, with the real binary on synthetic screenshots (none committed).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setup, cli } = require("../helpers");

const writeScreens = (dir, ids) => { const f = path.join(dir, "screens.txt"); fs.writeFileSync(f, ids.join("\n") + "\n"); return f; };

module.exports = async () => {
  const synth = setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-report-browser-"));
  const shots = [["en", "home", "01-en-phone.png"], ["en", "raw", "14-en-raw-key.png"], ["de", "home", "03-de-phone.png"], ["de", "raw", "17-de-umlauts.png"]];
  for (const [l, s, f] of shots) {
    fs.mkdirSync(path.join(dir, "shots", l), { recursive: true });
    fs.copyFileSync(path.join(synth, f), path.join(dir, "shots", l, `${s}.png`));
  }
  // A file name that is markup (spec 18 "Injection fixtures").
  fs.copyFileSync(path.join(synth, "02-en-small.png"), path.join(dir, "shots", "en", '"><img src=x onerror=window.__pwned=1>.png'));
  const run = (args) => {
    const r = cli(args, { cwd: dir });
    if (![0, 1].includes(r.code)) throw new Error(`catscan ${args.join(" ")}: exit ${r.code}\n${r.stderr}`);
  };
  const base = ["check", "shots", "--present", "Welcome back", "--expect-locales", "en,de,fr", "-q"];
  run([...base, "--report", "embed.html", "--results", "results.json"]);
  run([...base, "--report", "link.html", "--report-images", "link"]);
  // Recognized and check text that is markup, and the line separators the JSON block must escape.
  const file = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
  const evil = "</script><script>window.__pwned=1</script>\"><img src=x onerror=window.__pwned=1>  ";
  for (const e of file.results) for (const c of e.checks) c.text = evil + c.text;
  fs.writeFileSync(path.join(dir, "evil.json"), JSON.stringify(file));
  run(["report", "evil.json", "--out", "evil.html"]);
  // TODO-038 T3: an approved baseline, then a second build: de/home text changed, en/raw gone, en/extra new, de/raw
  // ambiguous (two inputs against one), en/home unchanged and passing (skippable). Layout-relative paths match across
  // the two folders. No --expect-locales: en/raw would be missing, not gone.
  run(["results", "baseline", "results.json", "--out", "base.json", "--allow-incomplete"]);
  const next = [["en", "home", "01-en-phone.png"], ["de", "home", "17-de-umlauts.png"], ["en", "extra", "02-en-small.png"], ["de", "raw", "17-de-umlauts.png"]];
  for (const [l, s, f] of next) {
    fs.mkdirSync(path.join(dir, "next", l), { recursive: true });
    fs.copyFileSync(path.join(synth, f), path.join(dir, "next", l, `${s}.png`));
  }
  fs.copyFileSync(path.join(synth, "17-de-umlauts.png"), path.join(dir, "next", "de", "raw.jpg"));
  const again = ["check", "next", "--present", "Welcome back", "-q", "--baseline", "base.json"];
  run([...again, "--report", "baseline.html", "--results", "compared.json"]);
  run([...again, "--text-record", "digest", "--report", "digest.html"]);
  // Recognized text in the line diff and minor_diff that is markup.
  const cmp = JSON.parse(fs.readFileSync(path.join(dir, "compared.json"), "utf8"));
  const changed = cmp.baseline.cells.find((c) => c.state === "changed");
  changed.diff.added.unshift(evil); changed.diff.added_count += 4; // 3 lines past the cap: "3 more"
  const same = cmp.baseline.cells.find((c) => c.state === "unchanged");
  same.minor_diff = { added: [evil], removed: ["welcome"], added_count: 1, removed_count: 1 };
  fs.writeFileSync(path.join(dir, "evil-baseline.json"), JSON.stringify(cmp));
  run(["report", "evil-baseline.json", "--out", "evil-baseline.html"]);
  // TODO-075: two devices in one report; android lacks de/raw, so the coverage line and device filter differ.
  const devShots = [["ios", "en", "home", "01-en-phone.png"], ["ios", "de", "home", "03-de-phone.png"], ["ios", "de", "raw", "17-de-umlauts.png"],
    ["android", "en", "home", "02-en-small.png"], ["android", "de", "home", "03-de-phone.png"]];
  for (const [d, l, s, f] of devShots) {
    fs.mkdirSync(path.join(dir, "devices", d, l), { recursive: true });
    fs.copyFileSync(path.join(synth, f), path.join(dir, "devices", d, l, `${s}.png`));
  }
  run(["check", "devices", "--layout", "{device}/{locale}/{screen}", "--present", "Welcome back", "--expect-devices", "ios,android", "--expect-locales", "en,de",
    "--expect-screens", writeScreens(dir, ["home", "raw"]), "-q", "--report", "devices.html"]);
  // TODO-076: two text sizes; en/home passes at default and fails at large (the `large text` badge), de fails at both.
  const sizeShots = [["default", "en", "home", "01-en-phone.png"], ["default", "de", "home", "03-de-phone.png"], ["large", "en", "home", "03-de-phone.png"], ["large", "de", "home", "03-de-phone.png"]];
  for (const [t, l, s, f] of sizeShots) {
    fs.mkdirSync(path.join(dir, "sizes", t, l), { recursive: true });
    fs.copyFileSync(path.join(synth, f), path.join(dir, "sizes", t, l, `${s}.png`));
  }
  run(["check", "sizes", "--layout", "{text_size}/{locale}/{screen}", "--present", "Welcome back", "--expect-text-sizes", "default,large", "--expect-locales", "en,de", "-q", "--report", "sizes.html"]);
  process.env.CATSCAN_REPORT_DIR = dir;
};
