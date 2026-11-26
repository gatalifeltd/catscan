# Apply: one branch, one commit, a fixed order

Only after the user's yes to the plan.

## Before the first step

1. `git status --porcelain` must be empty. Otherwise refuse: "commit or stash your changes first; the upgrade
   is one commit you can drop".
2. Create a branch: `git switch -c catscan-upgrade-<target>`. Note the files each step touches.

## Steps, in this order

1. **S1.** First apply the `edits[]` rows whose `field` is `overrides`, `resolutions` or `pnpm.overrides` (an
   override left at the old version makes `npm install` fail), then run each line of `commands[]` from its `cwd`,
   then apply the other `edits[]` rows marked `via: "edit"`. Every lockfile that resolves `@catscan/*` is
   regenerated, so none still resolves the old version.
2. **S2.** Apply each other S2 `edits[]` row (CI files, the scripts they call, `package.json` scripts): replace
   `from` with `to` on the line that holds `from`, at or near `line`.
3. **S3, project files.** Apply the `edits[]` rows on `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`.
4. **S5.** Rerun the installers named in `references/surfaces.md` (S5) for each block found.

S3 user files and S4 are never edited: their commands go into the report.

## A step fails

A step that exits non-zero stops the apply before the commit. Print:

- the step and its command;
- the last lines of its stderr;
- the files touched so far;
- `git restore --source=HEAD -- <those files>`, then the reinstall line for the lockfile's manager
  (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`),
  since `node_modules` may now mix two versions.

Do not retry with other flags and do not edit a lockfile by hand.

## Done check

1. Run the project's own catscan: `node_modules/.bin/catscan doctor --json` in each folder that installs
   `@catscan/cli`, or in its workspace root, where npm and yarn put the bin (a project that only pins catscan in
   CI skips this). Read the `checks[]` entries named `binary`
   and `version`: both must be `ok` (`version` fails when the packages differ). Other checks, such as `signature`
   on a local build, do not decide the upgrade. doctor checks the binary only on an Apple silicon Mac: elsewhere
   skip this step, say so, and let step 3 decide.
2. Commit the touched files as one commit: `chore: move catscan to <target>`.
3. Rerun `find-surfaces.mjs <repo>`: every project-scope surface with an exact version must show the target, and
   `skew` must be empty, except the references the user chose to keep (a range, a tag, `file:`, `workspace:`) and
   the lockfile rows they resolve. Anything else: stop and name the surface still behind (file, line, current).

## Rollback

Drop the branch (`git switch -` then `git branch -D catscan-upgrade-<target>`), or `git revert` its one commit
after a merge.
