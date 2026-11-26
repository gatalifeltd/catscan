# catscan-upgrade fixture

A small project that holds catscan in every place the `catscan-upgrade` skill moves: an npm dependency with its
lockfile, a CI pin, a project MCP config, a testing-rules block written by `agent-rules.mjs` and a baseline named
by the CI job. Everything is pinned to an old version (0.1.0) that exists only on the test's local registry.

The test packs the current catscan packages, serves them and a 0.1.0 copy from a local registry, installs 0.1.0,
then runs the skill's scripted steps: the plan, the package-manager commands, the pin rewrites and the rule
installer. It checks that every surface reaches the target with no skew, that `catscan doctor` passes `binary` and
`version`, that a second installer run changes nothing, that the baseline is untouched, and that a failing
package-manager step and an unknown version both stop with nothing kept. Nothing reaches the public npm registry.
