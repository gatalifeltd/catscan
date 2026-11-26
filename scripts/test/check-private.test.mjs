// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Spec 25 private-data check: one fixture per rule, the matched name never printed, the name list fails closed
// where required and prints a notice in lab CI mode (D3, D17).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { main } from "../check-private.mjs";

const NAME = "Zorblax Quest";
// Built at run time so this file does not trip its own home-path rule.
const HOME = ["", "Users", ""].join("/");
const BS = String.fromCharCode(92);

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "catscan-private-"));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  return root;
}

function run(root, argv = [], env = { CATSCAN_PRIVATE_NAMES: `# studio names\n${NAME}\n` }) {
  const out = [];
  const err = [];
  const code = main(["--root", root, ...argv], env, { log: (s) => out.push(s), error: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const jpeg = (exif) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  exif ? Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x0e]), Buffer.from("Exif\0\0", "latin1"), Buffer.alloc(6)]) : Buffer.alloc(0),
  Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]),
]);
function png(extra) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)),
    ...(extra ? [chunk(extra, Buffer.from("MM\0*"))] : []), chunk("IEND", Buffer.alloc(0))]);
}

test("a clean tree passes", () => {
  const r = run(tree({ "README.md": "# catscan - a tool\nRun it from /Users/me/app or ~/app.\n", "docs/a.png": png(), "bench/b.jpg": jpeg(false), "src/x.js": "const dash = '\u2014';\n", ".env.example": "KEY=\n" }));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /check-private: ok \(5 files, 1 private names\)/);
});

test("each rule fails with rule ID, file:line and hint, and never prints the private name", () => {
  const r = run(tree({
    "docs/notes.md": `intro\nBuilt for ${NAME.toLowerCase()} screens.\n`,
    "docs/zorblax quest/readme.txt": "ok\n",
    "src/a.js": `x\nconst p = "${HOME}jdoe/work";\n`,
    "src/b.ps1": `C:${BS}Users${BS}jdoe${BS}x\n`,
    "docs/c.md": "a \u2014 b\n",
    "docs/exif.jpg": jpeg(true),
    "docs/exif.png": png("eXIf"),
    ".env.local": "TOKEN=x\n",
    ...Object.fromEntries(["png", "jpg", "jpeg", "heic", "webp", "mp4", "mov", "webm"].map((e) => [`shots/s.${e}`, "x"])),
  }));
  assert.equal(r.code, 1);
  for (const line of [
    "private-name docs/notes.md:2 - ", "private-name-path docs/<private>/readme.txt:1 - ", "home-path src/a.js:2 - ",
    "home-path src/b.ps1:1 - ", "em-dash docs/c.md:1 - ", "image-metadata docs/exif.jpg:1 - ", "image-metadata docs/exif.png:1 - ",
    "env-file .env.local:1 - ", "media-outside shots/s.webm:1 - ", "media-outside shots/s.heic:1 - ",
  ]) assert.ok(r.err.includes(line), `missing ${line}\n${r.err}`);
  assert.equal((r.err.match(/^media-outside /gm) ?? []).length, 8);
  assert.doesNotMatch(r.err, /zorblax|jdoe/i, "a finding must not print the matched text");
  assert.match(r.err, /image-metadata docs\/exif\.jpg:1 - strip EXIF and GPS metadata/);
});

// Value: protects=GPS and EXIF detection beyond the JPEG APP1 and PNG eXIf cases (PNG text chunks, XMP GPS, WebP, HEIC); fails_when=the PNG text-chunk scan, the XMP fallback or the WebP/HEIC branch is dropped or broken, so a docs/ image leaks location data, or an XMP block without GPS starts failing; why_new=the existing fixtures cover only jpeg(true) and png("eXIf"); seam=none; no_claim=real camera files
test("GPS in PNG text chunks and XMP, and EXIF in WebP and HEIC, fail under docs/", () => {
  const textPng = (type, body) => {
    const p = png();
    const data = Buffer.from(body, "latin1");
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([p.subarray(0, 33), len, Buffer.from(type, "latin1"), data, Buffer.alloc(4), p.subarray(33)]);
  };
  const xmpJpeg = (inner) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from("http://ns.adobe\0", "latin1"),
    Buffer.from(`<x:xmpmeta>${inner}</x:xmpmeta>`, "latin1"), Buffer.from([0xff, 0xd9])]);
  const r = run(tree({
    "docs/t.png": textPng("tEXt", "Comment\0GPS 51.5N"),
    "docs/i.png": textPng("iTXt", "XML:com.adobe.xmp\0\0\0\0\0<exif:GPSLatitude>51</exif:GPSLatitude>"),
    "docs/x.jpg": xmpJpeg("<exif:GPSLatitude>51</exif:GPSLatitude>"),
    "docs/w.webp": Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBPEXIF", "latin1"), Buffer.alloc(8)]),
    "docs/h.heic": Buffer.concat([Buffer.from("\0\0\0\x18ftypheic", "latin1"), Buffer.from("Exif\0\0MM", "latin1")]),
    "docs/clean.png": textPng("tEXt", "Software\0catscan"),
    "docs/clean.jpg": xmpJpeg("<dc:title>shot</dc:title>"),
  }));
  assert.equal(r.code, 1);
  const hits = (r.err.match(/^image-metadata \S+/gm) ?? []).map((l) => l.split(" ")[1]).sort();
  assert.deepEqual(hits, ["docs/h.heic:1", "docs/i.png:1", "docs/t.png:1", "docs/w.webp:1", "docs/x.jpg:1"]);
});

test("a name inside a longer word is not a hit", () => {
  assert.equal(run(tree({ "a.md": "Zorblax Questing is fine\n" })).code, 0);
});

test("a missing name list fails when required and prints a notice in lab CI mode", () => {
  const root = tree({ "a.md": "ok\n" });
  const req = run(root, [], {});
  assert.equal(req.code, 1);
  assert.match(req.err, /^names-missing -:0 - set CATSCAN_PRIVATE_NAMES/m);
  const lab = run(root, ["--names=if-available"], {});
  assert.equal(lab.code, 0);
  assert.match(lab.out, /notice: no private name list on this machine/);
});

test("the list can come from CATSCAN_PRIVATE_NAMES_FILE", () => {
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-names-")), "names.txt");
  fs.writeFileSync(list, `${NAME}\n`);
  const r = run(tree({ "a.md": `${NAME}\n` }), [], { CATSCAN_PRIVATE_NAMES_FILE: list });
  assert.equal(r.code, 1);
  assert.match(r.err, /private-name a\.md:1/);
});

test("--allowlist checks only the lab files public-paths.txt lands, overlay included", () => {
  const root = tree({
    "scripts/public-paths.txt": "README.md\ndocs/public.md\n",
    "README.md": "ok\n",
    "docs/public.md": `see ${HOME}jdoe/x\n`,
    "docs/lab-only.md": `see ${HOME}jdoe/x\n`,
    "public/CONTRIBUTING.md": "a \u2014 b\n",
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  const r = run(root, ["--allowlist"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /home-path docs\/public\.md:1/);
  assert.match(r.err, /em-dash public\/CONTRIBUTING\.md:1/);
  assert.doesNotMatch(r.err, /lab-only/);
});

// Value: protects=home paths without a trailing separator, metadata past 1 MiB or in a deflated PNG chunk, and gif/avif/mkv screenshots are caught, while path segments named home are not; fails_when=HOME_RE needs a trailing slash again, the WebP scan stops at 1 MiB, zTXt raw profiles pass, or MEDIA loses a format; why_new=review findings on pass 1; seam=none; no_claim=real exiftool output
test("review fixes: bare home paths, late WebP EXIF, deflated PNG profiles, more media types, home as a segment", async () => {
  const { deflateSync } = await import("node:zlib");
  const zchunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); };
  const pngRaw = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), zchunk("IHDR", Buffer.alloc(13)),
    zchunk("zTXt", Buffer.concat([Buffer.from("Raw profile type exif\0\0", "latin1"), deflateSync(Buffer.from("exif data"))])), zchunk("IEND", Buffer.alloc(0))]);
  const riff = (fourcc, data) => { const len = Buffer.alloc(4); len.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(fourcc, "latin1"), len, data]); };
  const webp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP", "latin1"), riff("VP8X", Buffer.alloc(1100001)), Buffer.alloc(1), riff("EXIF", Buffer.from("MM\0*", "latin1"))]);
  const r = run(tree({
    "src/a.sh": `cd ${HOME}jdoe\n`, "docs/b.md": `path "${HOME}jdoe"\n`, "docs/late.webp": webp, "docs/raw.png": pngRaw,
    "shots/a.gif": "x", "shots/b.avif": "x", "shots/c.mkv": "x",
    "src/ok.js": 'const k = "screens/home/title"; // de/home.png\n',
  }));
  for (const line of ["home-path src/a.sh:1", "home-path docs/b.md:1", "image-metadata docs/late.webp:1", "image-metadata docs/raw.png:1",
    "media-outside shots/a.gif:1", "media-outside shots/b.avif:1", "media-outside shots/c.mkv:1"]) assert.ok(r.err.includes(line), `missing ${line}\n${r.err}`);
  assert.doesNotMatch(r.err, /src\/ok\.js/);
});

// Value: protects=home paths at any depth and in file URLs, EXIF keywords in PNG text, metadata in AVIF; fails_when=HOME_RE is anchored to the path start again, the keyword is not tested, or AVIF skips the scan; why_new=pass 2 review regressions (firmlink, -I flag, file URL, tEXt keyword); seam=none; no_claim=real exiftool output
test("review pass 2: nested and file-URL home paths, EXIF keywords in PNG text, AVIF metadata", () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); };
  const r = run(tree({
    "a.md": `see file://${HOME}jdoe/shot.png\n`,
    "b.md": `see file://${HOME}jdoe\n`,
    "c.sh": `ls /System/Volumes/Data${HOME}jdoe/x\n`,
    "d.sh": `cc -I${HOME}jdoe/include x.c\n`,
    "e.sh": `cd /mnt/c${HOME}jdoe/w\n`,
    "docs/g.png": Buffer.concat([sig, chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", Buffer.from("exif:GPSLatitude\u000051/1", "latin1")), chunk("IEND", Buffer.alloc(0))]),
    "docs/h.avif": Buffer.concat([Buffer.from("....ftypavif", "latin1"), Buffer.alloc(64), Buffer.from("Exif\0\0", "latin1")]),
  }));
  for (const f of ["a.md", "b.md", "c.sh", "d.sh", "e.sh"]) assert.ok(r.err.includes(`home-path ${f}:1`), `missing ${f}\n${r.err}`);
  assert.ok(r.err.includes("image-metadata docs/g.png:1"), r.err);
  assert.ok(r.err.includes("image-metadata docs/h.avif:1"), r.err);
});

// Value: protects=UTF-16 and other binary files, symlinks, escaped Windows paths and TIFF IFDs get checked, errors are redacted, and a WebP with "EXIF" only inside image data passes; fails_when=the NUL-byte skip returns, symlinks are followed, a landPlan error prints a raw name, or WebP matches a substring; why_new=adversarial review findings at the review cap; seam=none; no_claim=real exiftool or iconv output
test("fix-check: UTF-16 and binary text, symlink text, escaped Windows paths, TIFF IFD, benign WebP, redacted errors", () => {
  const utf16 = (s, bom) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);
  const tiff = Buffer.alloc(32); tiff.write("II", 0, "latin1"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8); tiff.writeUInt16LE(0x8825, 10);
  const riff = (fourcc, data) => { const len = Buffer.alloc(4); len.writeUInt32LE(data.length); return Buffer.concat([Buffer.from(fourcc, "latin1"), len, data]); };
  const benignWebp = Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP", "latin1"), riff("VP8 ", Buffer.from("xxEXIFxx", "latin1"))]);
  const BS2 = BS + BS;
  const root = tree({
    "a.strings": utf16(`"k" = "${NAME}";\n`, true),
    "b.strings": utf16(`"p" = "${HOME}jdoe/x";\n`, false),
    "cjk.strings": utf16(`"\u4e00" = "${NAME}";\n`, false),
    "c.pdf": Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(` ${HOME}jdoe/doc `, "latin1")]),
    "d.json": `{"p": "C:${BS2}Users${BS2}jdoe${BS2}x"}\n`,
    "docs/e.tif": tiff,
    "docs/f.webp": benignWebp,
  });
  fs.symlinkSync(`${HOME}jdoe/secret`, path.join(root, "link"));
  const r = run(root);
  for (const line of ["private-name a.strings:1", "private-name cjk.strings:1", "home-path b.strings:1", "home-path c.pdf:1", "home-path d.json:1", "image-metadata docs/e.tif:1", "home-path link:1"]) {
    assert.ok(r.err.includes(line), `missing ${line}\n${r.err}`);
  }
  assert.doesNotMatch(r.err, /f\.webp/);
  const repo = tree({ "scripts/public-paths.txt": `${NAME}/\n`, "x.md": "x\n" });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  const bad = run(repo, ["--allowlist"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /stale-entry: .*<private>\//);
  assert.doesNotMatch(bad.err, /zorblax/i);
});

// Value: protects=red-team repros on the name rule (a name split over lines, double spaces or &nbsp;, a name in image or video metadata, files under node_modules in an export, the --list plan, merged name sources); fails_when=the name is matched per line or by literal spacing, media skip the name scan, walk drops node_modules, --list is ignored, or a blank secret hides the file; why_new=review pass 1 reproduced each leak; seam=none; no_claim=real camera or video encoders
test("names across line breaks and entities, in media metadata, under node_modules, from --list and merged sources", async () => {
  const { deflateSync } = await import("node:zlib");
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngText = (type, data) => Buffer.concat([sig, chunk("IHDR", Buffer.alloc(13)), chunk(type, data), chunk("IEND", Buffer.alloc(0))]);
  const [first, second] = NAME.split(" ");
  const r = run(tree({
    "wrap.md": `intro\nThe ${first}\n${second} launch.\n`,
    "spaces.md": `The ${first}  ${second} launch.\n`,
    "nbsp.html": `<p>${first}&nbsp;${second}</p>\n${first} ${second}\n`,
    "docs/img/title.png": pngText("tEXt", Buffer.from(`Title\0${NAME}`, "latin1")),
    "docs/img/z.png": pngText("zTXt", Buffer.concat([Buffer.from("Comment\0\0", "latin1"), deflateSync(Buffer.from(`for ${NAME}`))])),
    "docs/img/clip.mov": Buffer.concat([Buffer.alloc(16), Buffer.from(`udta©nam${NAME}`, "latin1"), Buffer.alloc(16)]),
    "bench/clip.mp4": Buffer.concat([Buffer.alloc(16), Buffer.from(NAME, "utf16le"), Buffer.alloc(16)]),
    "docs/img/home.png": pngText("tEXt", Buffer.from(`Source\0${HOME}alice/Desktop/s.png`, "latin1")),
    "core/node_modules/m/notes.txt": `${NAME}\n`,
  }));
  assert.equal(r.code, 1);
  for (const hit of ["wrap.md:2", "spaces.md:1", "nbsp.html:1", "nbsp.html:2", "docs/img/title.png:1", "docs/img/z.png:1", "docs/img/clip.mov:1", "bench/clip.mp4:1", "core/node_modules/m/notes.txt:1"]) {
    assert.match(r.err, new RegExp(`private-name ${hit.replace(/[./]/g, "\\$&")}`), hit);
  }
  assert.match(r.err, /home-path docs\/img\/home\.png:1/);
  assert.doesNotMatch(r.out + r.err, /zorblax/i);
  // --list checks exactly the listed paths, even ones a walk would not reach.
  const root = tree({ "a.md": "clean\n", "b.md": `${NAME}\n` });
  const list = path.join(root, "..", `${path.basename(root)}.list`);
  fs.writeFileSync(list, "a.md\n");
  assert.equal(run(root, ["--list", list]).code, 0);
  fs.writeFileSync(list, "a.md\nb.md\n");
  assert.match(run(root, ["--list", list]).err, /private-name b\.md:1/);
  // A blank or stale secret never hides the file's names.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "catscan-names-")), "names.txt");
  fs.writeFileSync(file, `${NAME}\n`);
  for (const secret of ["", "# none\n", "Other Studio\n"]) {
    assert.match(run(tree({ "c.md": `${NAME}\n` }), [], { CATSCAN_PRIVATE_NAMES: secret, CATSCAN_PRIVATE_NAMES_FILE: file }).err, /private-name c\.md:1/, JSON.stringify(secret));
  }
});

// Value: protects=review pass 2 red-team repros (slug, CamelCase, encoded and comment-wrapped forms of a name, emphasis, soft hyphens, fullwidth letters, BOM-less UTF-16 with mostly non-Latin text, a --list that names a missing file or nothing) and no new false hit for a short name in media bytes; fails_when=GAP goes back to whitespace only, NFKC folding or the binary multi-view scan is dropped, --list silently skips, or short names lose their boundary in media; why_new=each form passed on pass 2; seam=none; no_claim=every possible obfuscation
test("slug, wrapped, emphasized, folded and UTF-16 forms of a name are caught; --list fails closed", () => {
  const [first, second] = NAME.split(" ");
  const forms = {
    "kebab.md": `${first.toLowerCase()}-${second.toLowerCase()}`,
    "snake.md": `${first}_${second}`,
    "camel.md": `${first}${second}`,
    "url.md": `${first}%20${second}`,
    "comment.js": `// ${first}\n// ${second}`,
    "quote.md": `> ${first}\n> ${second}`,
    "bold.md": `**${first}** ${second}`,
    "soft.md": `${first.slice(0, 3)}­${first.slice(3)} ${second}`,
    "escaped.sh": `cd ~/Projects/${first}\\ ${second}`,
    "windows.txt": `C:\\${first}\\${second}\\x`,
    "join.js": `const t = "${first} " +\n  "${second}";`.replace("\n", " "),
    "bidi.md": `${first.slice(0, 2)}\u200e${first.slice(2)}\u034f ${second}`,
    "glued.md": `re\u200b${NAME} and re\u00ad${NAME} and ${NAME}\u2060s`,
    "wide.md": [...`${first} ${second}`].map((c) => (c === " " ? c : String.fromCharCode(c.charCodeAt(0) + 0xfee0))).join(""),
  };
  const files = Object.fromEntries(Object.entries(forms).map(([f, t]) => [f, `x\n${t}\n`]));
  files["cat.strings"] = Buffer.from(`"a" = "${"Продолжить ".repeat(30)}${NAME}";\n`, "utf16le");
  const r = run(tree(files));
  for (const f of Object.keys(forms)) assert.match(r.err, new RegExp(`private-name ${f.replace(".", "\\.")}:2`), f);
  assert.match(r.err, /private-name cat\.strings:1/);
  const odd = run(tree({ "odd.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(NAME, "utf16le"), Buffer.alloc(9)]) }));
  assert.match(odd.err, /private-name odd\.bin:1/);
  // A path that matches only after folding is redacted whole.
  const wide = [...first].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join("");
  const folded = run(tree({ [`docs/${wide}-${second}.md`]: "clean\n" }));
  assert.match(folded.err, /private-name-path <private>:1/);
  assert.doesNotMatch(folded.err, new RegExp(wide));
  assert.doesNotMatch(r.out + r.err, /zorblax/i);
  // A short name needs a word boundary inside media bytes, a long one does not.
  const media = tree({ "docs/img/a.png": Buffer.from("xxEvaxx Zorblaxquestyy") });
  const short = run(media, [], { CATSCAN_PRIVATE_NAMES: "Eva\n" });
  assert.equal(short.code, 0, short.err);
  assert.equal(run(media, [], { CATSCAN_PRIVATE_NAMES: "Zorblax Quest\n" }).code, 1);
  // --list fails closed on a missing path and on an empty list.
  const root = tree({ "a.md": "clean\n" });
  const list = path.join(root, "..", `${path.basename(root)}.list`);
  fs.writeFileSync(list, "a.md\nmissing.md\n");
  assert.equal(run(root, ["--list", list]).code, 2);
  fs.writeFileSync(list, "");
  const empty = run(root, ["--list", list]);
  assert.equal(empty.code, 2);
  assert.match(empty.err, /--list is empty/);
});
