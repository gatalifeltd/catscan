# Diffs and batches: how the plan's changes are made and proved

## Make each diff

Make each diff with `git diff` in a scratch copy of the commit, never by hand-typing hunks, and commit nothing,
in the scratch copy or anywhere else (a dry run commits nothing). Write every scratch file there or in the plan
folder.

```sh
mkdir <plan>/scratch && git -C <repo> archive <commit> | tar -x -C <plan>/scratch
cd <plan>/scratch && git init -q && git add -A -f     # an index only; -f keeps tracked files a .gitignore matches
# per diff, in NN order: edit the files, then
git add -N -f . && git diff > <plan>/diffs/NN-<point>.diff && git add -A -f   # the next diff starts from this one
```

Experimental diffs are numbered after every default diff and add only their own files (`checks.md`). Each is proved on
all default diffs, so an experimental batch is offered only after every default batch; when the developer declines
one, remake the experimental diff against what was applied (`checks.md`).

## Write the batches

`<plan>/batches` has one line per default batch: its name, its default diffs (file names, `.diff` optional), then
`after` and the batches it needs. Every default diff is in exactly one batch; experimental diffs are never listed
(each is its own batch). Shared wiring a later batch needs is its own batch, named in that batch's `after`. The plan
shows each batch with its diffs and its `after` list, so the developer sees what a batch needs before approving it.

```text
wiring  01-shots-wrapper
e2e     02-e2e-shots 03-e2e-canvas  after wiring
store   04-store-kit
```

## Prove them

`bash <skill-dir>/scripts/check-diffs.sh <repo> <plan>` builds its scratch repository under `$TMPDIR` and touches
nothing in the repo. It proves that every diff applies in order at the commit, that each experimental diff applies
on the default diffs alone and shares no path with another, and that every combination of batches applies with
the batches they name after `after`. Batches whose own diffs edit no file in common cannot conflict (each
runs with the batches it names), so it tries combinations inside each group of batches that edit a shared file (or a file and a folder of the same name) only; a group of more than 8 fails with its fix. A FAIL line names the diff, batch or path and the fix; fix it and rerun. A run
whose last line says the batches are not proved is not done: write `<plan>/batches` and rerun.

In apply mode, a batch whose `after` batch was declined is not applied: offer it again once that batch is approved.
