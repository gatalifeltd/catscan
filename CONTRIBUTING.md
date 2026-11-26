# Contributing to catscan

## How contributions work

catscan does not accept pull requests. The maintainers write every change themselves, so there is no contributor license agreement and no review queue. Issues are the way in:

- **Bug report:** what you ran, what you expected, what happened, and the output of `npx -y @catscan/cli doctor --json`.
- **Wrong-OCR report:** the text catscan read and the text on screen. Attach a synthetic or shareable image only; never a screenshot you are not allowed to publish.
- **Feature request:** the check you need and the screens it is for.

Pull requests are turned off for this repository. If you already wrote a fix, describe it in an issue; the maintainers take it from there.

## Build and test

Requirements: an Apple silicon Mac, macOS 15 or later, Xcode with Swift 6, Node 22 or later.

```sh
npm ci
npm run build        # swift build -c release --package-path core
npm run test:unit    # Node tests
npm run test:swift   # Swift tests
npm run bench:check  # README and docs/BENCHMARKS.md match the committed results
```

The checks CI runs on every change:

```sh
node scripts/docs-check.mjs --public                    # em dashes and links in docs
node scripts/check-workflows.mjs --product .github/workflows
node scripts/check-headers.mjs                          # SPDX header on every source file
node scripts/check-licenses.mjs                         # shipped dependency licenses
node scripts/check-private.mjs --names=if-available     # paths, media, metadata, env files
```

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `bench:`, `chore:`. Every merge to `main` is a squash merge.

## Conduct and security

Everyone in the project follows the [code of conduct](CODE_OF_CONDUCT.md). Report a vulnerability privately as described in [SECURITY.md](SECURITY.md), never in a public issue.
