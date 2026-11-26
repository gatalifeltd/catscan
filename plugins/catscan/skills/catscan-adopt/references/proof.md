# Mutation proof through capture

A catscan check proves something only if it fails when the screen is wrong. Changing the expected text in
the check proves nothing: it tests the check, not the capture. Run this for every applied point.

## Steps

1. **Pick the mutation in the app, not in the test.** Change one string visible in a screenshot the run keeps: the
   catalog entry, the literal passed to `fillText` or the engine text object, or the view's label. Prefer
   a change that keeps the layout (same length) so only the text differs: `Play` -> `Plai`. A point checked
   only by the finding commands needs a defect they report: a raw key, a placeholder, English in another
   locale, or a string long enough to cut (`truncated`). Per command: a price or date in the other locale's form
   (`formats`); two labels moved onto each other (`overlap`); a one-row button label made long enough to wrap,
   or a top label moved under the cutout (`fit`); a label colour close to its background (`contrast`). An
   experimental check's proof passes when the finding shows in its results; it never fails the run.
   Never mutate a file the check also reads as expected text or comparison (`--catalog`, `--base`, an expect
   file): the check would compare the changed screen with the changed string and pass. When the app renders from
   that same file, mutate through a test-only override the app loads, or record the point as unprovable with
   that reason. A test that asserts the original string before the shot fails before catscan runs: pick
   another string or screen. A catalog mutation names a key that exists: find the key in the code that draws the
   text (the view, scene or component) and in the catalog the app loads, and check the catalog holds it before you
   write the mutation; a key you inferred from the label (`menu` for a Play button) is no mutation.
2. **Delete the stale screenshots** the point reads (the shot folder of that run), so the check cannot
   pass on old images.
3. **Run the project's normal command** for that layer (the one in the plan, the same CI uses). Rebuild
   the app first when the string is compiled in (native apps, bundled games). The command must not depend on
   other points' outputs: a narrowed run that exits 4 for another point's missing shots is no proof.
4. **The check must fail** with exit 1, naming the mutated text, and `closest` should show the mutated
   line. Any other exit code (2, 3, 4, 5) is not a proof: fix the cause first.
5. **Restore the string**, delete the shots again, rerun: the check must pass and every other test must
   give the same result as before the point was applied.

## Record

Append to `<plan>/proofs.md`, one block per point:

```text
point:     N <name>
mutation:  <file:line> "<before>" -> "<after>"
command:   <the exact command>
red:       exit 1, <check that failed>, closest "<line>"
green:     exit 0 after restore
suite:     <passed/failed counts before and after the point>
```

## When the proof cannot run here

No device, no simulator or emulator, no Mac, or the app does not build: do not mark the point done. Say
in one line what is missing and leave the point applied-unproven or revert it, as the developer chooses.
Every simulator, emulator or browser the proof starts renders on the host GPU (Chromium on macOS:
`--use-angle=metal`; Android emulators: `-gpu host`), never a CPU renderer.
