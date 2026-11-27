# @catscan/playwright

Playwright matchers that assert on the text drawn on the screen, read with Apple Vision on an Apple silicon Mac, locally or in CI: text in a `<canvas>`, WebGL or video, and text that CSS cuts off, which the DOM cannot show.

| Matcher | Fails when |
| --- | --- |
| `toShowText(text \| text[], options?)` | a text is not visible; `.not.toShowText` fails when one is |
| `toHaveNoTruncation(options?)` | a visible text is cut off |
| `toHaveNoOverlap(options?)` | a text is drawn over another text or over an icon, image or control |
| `toHaveNoUntranslated(options?)` | a raw key, an unfilled placeholder or, with catalogs, an untranslated or wrong-language string is shown |

## Requirements

Apple silicon Mac, macOS 15 or later, Node 22 or later: your own Mac or a macOS CI runner (GitHub's `macos-15` and `macos-26` work). `@playwright/test` is a peer dependency (`>=1.50.0 <2`); your project's own copy is used.

## Install

```bash
npm install -D @catscan/playwright
```

npm installs the catscan binary with it.

## First test

One import and one line, no catalog and no catscan config:

```ts
import { test } from "@playwright/test";
import { expect } from "@catscan/playwright"; // Playwright's expect with the catscan matchers

test("home", async ({ page }) => {
  await page.goto("/"); // your app, with `baseURL` set in playwright.config
  await expect(page).toHaveNoUntranslated({ readyText: "Play" }); // a word your page shows once loaded
});
```

It fails on a raw key or an unfilled placeholder drawn anywhere on the screen, canvas included. Replace `"Play"` with a word your page always shows once it has loaded: the check waits for it, so it never reads a loading frame.

## Learn more

- [Playwright recipe](https://github.com/gatalifeltd/catscan/blob/main/docs/recipes/playwright.md): project defaults, catalogs, every matcher option
- [catscan on GitHub](https://github.com/gatalifeltd/catscan/blob/main/README.md)

## License

Apache-2.0: [LICENSE](https://github.com/gatalifeltd/catscan/blob/main/LICENSE).
