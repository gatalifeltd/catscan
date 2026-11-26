// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
"use strict";
// TODO-089 D6: `lane.mjs run packages --ci-nodes` runs the packages lane on several Node versions at once in one
// checkout, and the core-js prepack and postpack copy and delete packages/core-js/schema there. Every `npm pack` of
// core-js with its scripts (scripts/pack-smoke.mjs, test/upgrade/fixture.test.js) runs under this lock.
// The lock is a directory renamed into place with its pid already inside, so it never exists without a holder; a
// dead holder's lock is renamed aside by exactly one waiter before anyone takes it, and only the holder removes it.
const fs = require("node:fs");
const path = require("node:path");

const WAIT_MS = 600_000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function holder(dir) {
  try { return Number(fs.readFileSync(path.join(dir, "pid"), "utf8")) || 0; } catch { return 0; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** Waits for the checkout's pack lock and returns its release function. */
function packLock(root, { waitMs = WAIT_MS } = {}) {
  const dir = path.join(root, ".build/pack.lock");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (let n = 0; ; n++) {
    const mine = `${dir}.${process.pid}.${n}`;
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, "pid"), String(process.pid));
    try {
      fs.renameSync(mine, dir); // fails while a lock directory with its pid file is there
      // Renamed aside before removal: an emptied lock dir could be replaced by a waiter's rename (fix-check).
      return () => {
        if (holder(dir) !== process.pid) return;
        const gone = `${dir}.done.${process.pid}.${n}`;
        fs.renameSync(dir, gone);
        fs.rmSync(gone, { recursive: true, force: true });
      };
    } catch (e) {
      fs.rmSync(mine, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY", "EISDIR"].includes(e.code)) throw e;
    }
    const pid = holder(dir);
    if (pid && !alive(pid)) {
      const aside = `${dir}.dead.${process.pid}.${n}`;
      try { fs.renameSync(dir, aside); } catch { continue; } // another waiter moved it first
      if (holder(aside) === pid) fs.rmSync(aside, { recursive: true, force: true });
      else try { fs.renameSync(aside, dir); } catch { fs.rmSync(aside, { recursive: true, force: true }); } // a live lock, put back
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`pack lock ${dir} held by pid ${pid || "?"} for ${Math.round(waitMs / 1000)} s; if no catscan test runs, remove it: rm -r '${dir}'`);
    }
    sleep(200);
  }
}

module.exports = { packLock };
