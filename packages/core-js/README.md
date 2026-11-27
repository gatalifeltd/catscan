# @catscan/core-js

The shared Node layer of catscan: it finds and launches the signed catscan binary, talks to its `serve` process, renders results and maps them to exit codes. `@catscan/cli`, `@catscan/mcp` and `@catscan/playwright` are built on it. Use it directly to call catscan's checks from your own Node code; for tests and CI, [`@catscan/cli`](https://www.npmjs.com/package/@catscan/cli) and, for web tests, [`@catscan/playwright`](https://www.npmjs.com/package/@catscan/playwright) are the simpler entry points.

## Requirements

Apple silicon Mac, macOS 15 or later, Node 22 or later: your own Mac or a macOS CI runner (GitHub's `macos-15` and `macos-26` work). npm installs the catscan binary with the package.

## Install

```bash
npm install @catscan/core-js
```

## Library use

`Server` keeps one `catscan serve` process and answers requests in order; it restarts the process if a Vision read times out.

```js
const { Server } = require("@catscan/core-js");

(async () => {
  const server = new Server();
  try {
    const result = await server.request({ id: "1", command: "check", path: "screen.png", present: ["Sign in"] });
    if (result.error) throw new Error(result.error.message); // a request the binary refused
    console.log(result.verdict); // "pass" when "Sign in" is on the screen
  } finally {
    await server.close(); // ends the serve process, also after an error
  }
})();
```

Commands are `check`, `read`, `untranslated`, `truncated`, `overlap`, `fit`, `contrast` and `video`; each takes a `path` (a screenshot command also takes a base64 `image`) and returns the result envelope the CLI's `--json` prints. The package also carries the JSON schemas (`schema/`) and `behavior-changes.json`, the changes per release that can turn a passing check into a failing one.

## Learn more

- [The `serve` protocol: every request and response field](https://github.com/gatalifeltd/catscan/blob/main/docs/cli.md#serve)
- [CLI reference](https://github.com/gatalifeltd/catscan/blob/main/docs/cli.md)
- [catscan on GitHub](https://github.com/gatalifeltd/catscan/blob/main/README.md)

## License

Apache-2.0: [LICENSE](https://github.com/gatalifeltd/catscan/blob/main/LICENSE).
