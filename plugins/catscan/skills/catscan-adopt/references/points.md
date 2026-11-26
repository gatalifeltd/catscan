# Adoption points: confirm, drop, rank

`find-points.mjs` finds lines; it cannot tell whether a screenshot is already checked or whether a text
object is player-visible. Open the files of each group before you call it a point.

## Kinds

| Kind | Scope | A point when | Not a point when |
| --- | --- | --- | --- |
| `unchecked-shot` | (a) screenshots nobody checks | the test or script writes PNGs that no assert or diff tool reads (a person looking at them by eye still counts as unchecked) | the shot is only a debug artifact on failure (`screenshot: 'only-on-failure'`, a failure hook), or a check already reads it |
| `pixel-text` | (b) text checked by pixels or by an agent | a `toHaveScreenshot`/image-snapshot compare, or a test that hashes rendered images against a golden (`pixel-hash`), guards a screen whose point is its text, or an agent file says to open screenshots | the snapshot guards layout, colors or images only; keep it, a catscan check is added next to it, never instead |
| `canvas-text` | (c) text the DOM and accessibility tree cannot see | an e2e suite already loads the page that draws it (`fillText`, engine text objects) | the text is drawn only in a tool, a generator script or a playable build no test opens |
| `locale-folder` | (d) per-locale screenshots | shots are written per locale (a locale in the path or file name) by a test or store-shot pipeline, or store art with a title or tagline is rendered per locale (`store-art`, `locale-image-path`) | the folder holds design references, or art with no text |
| `video` | (e) recorded or rendered video | a test, script or device suite the project runs writes MP4 or MOV (a frame renderer piping to ffmpeg, a timelapse, a screen recording); it gets the `video` command | only a person records by hand: `run_by` is empty and no script, CI step or test names the producer (unsure: "Not examined") |

A video group's `run_by` lists test lines that name its producer file: open them before you call a producer
hand-run. A producer a test starts is run by that test, whatever the script's own name says.
A video group lists every line it matched: one suite file can hold several recordings (one per scenario or
flow). Each line that starts a recording is its own point or its own "Not examined" line, never folded into
the first one you resolve.

**Locale of a shot:** Iron rule 8 in `SKILL.md`.

A shot path built from any variable (`${output.l}-home`) may still be per-locale: find where the variable
is set before you rank it as `unchecked-shot`. A home-grown OCR or text check on the shots is not a point
unless catscan adds something it misses (truncation, wrong language, raw keys); then propose it next to the
existing check, never as a replacement.

Before you write a point's Why, search the same spec or script and its neighbours for an existing check of
that screen's text: a test API that returns the drawn text or its fit, an OCR script, a fit check at
generation time. If one exists, Why names it (file:line) and states only the gap catscan adds (pixels
instead of game state, wrong language, committed shots that went stale); with no gap left, drop the point.
One screen is one point: when two flows capture the same screen, keep the one with more locales or screens.
A point names every shot it checks (file:line); other shots in the same spec are a point of their own or a
dropped line. A shot only attached to the report (`testInfo.attach` with a body; find-points group `report-attachment`) is no
file: only the matcher on the live page reads it. List each one as a dropped line. An image the app exports at
runtime (a share card, a saved picture) goes under "Not examined" with the reason "runtime export, not captured
by the suite".

A canvas or engine text object is not a point on its own: the point is the e2e test (or capture script)
that renders that scene. Name the test, not the hundreds of text calls.

## Rank

1. Kind order a > b > c > d > e as in the table, unless the developer names a pain point.
2. Then by reach: screens or locales one point covers (a Maestro flow folder with 30 flows beats one spec;
   a per-locale screenshot matrix beats a few shots in one locale).
3. Then by cost: a point that needs no new dependency (CLI step on existing shots) before one that adds a
   package; a point that needs a device or emulator run last.

Rank orders the points; it never cuts them. List every confirmed point, however many (20 or more is a good
result in a large repo), and offer them as batches: one batch per test layer or app, highest rank first. A
point that fits two kinds takes the first in the table, and its Why names the other. When many points share
wiring (one hook in the test runner, one expect file per flow), make that wiring its own first diff and keep
each point's diff small.

## Not examined

A reason you cannot back with a file and line is not a reason. When you cannot tell whether a group is a point
(who runs a script, whether a test starts a producer, whether art carries text), do not guess ("hand-run, no test"):
write "could not determine, check by hand" with the check. The plan ends with a "Not examined" section: every file
or script that looks like a screenshot or video producer (find-points groups you did not open, scripts named for
shots, store art, recordings or timelapses) that you did not resolve, one line each with what to check. A missed
point listed there is honest; a guessed reason is not. Every capture and video the suite produces (each shot path,
each recorded or rendered video, each device or locale tour a suite script runs) is a point or a line here with its
reason. "Expected text unknown" is a reason only after you searched the code that draws that screen or scene for a
catalog key or literal: a key drawn there is the expected text (`check --present @<key> --catalog <catalog>`).

## Write each point as

Also list every candidate group you dropped, each with its own one-line reason, so a reviewer can check the
misses. Judge each producer (a spec, a flow, a script) in a find-points group: one point may cover a
whole folder through shared wiring, but a dropped producer gets its own line, never a shared one.


```text
N. <kind> - <one-line name>
   Where:   <files:lines of the producer and of the test command>
   Shots:   <where the PNGs land, per locale if any; gitignored or committed>
   Surface: <from surfaces.md>
   Checks:  <each default command group from checks.json with its kinds and the inputs it uses>
   Opt-in:  <each experimental group: command, opt_in, every kind it turns on, precision and flags; or "none">
   Why:     <what defect it would catch that nothing catches today>
   Expect:  <the first result you predict: pass, or which text fails; name the device or viewport when
            the defect shows only there, and say whether the normal command can select it>
```

## False points to avoid

- Matches inside build output, vendored engines or minified bundles (the script skips the usual folders;
  check any other generated folder by its header or size).
- `page.screenshot` used for an image comparison the project already asserts on: that is `pixel-text`
  at most, not `unchecked-shot`.
- Store-shot pipelines that take marketing frames with overlays: the app text inside them counts only
  where the frames come from the app build; burned-in captions per locale ship too and are a point of
  their own (kind d), checked on the framed output.
- A dirty working tree: candidates and diffs are made against the committed `head`; say so when the
  developer's local edits touch a point's files.
