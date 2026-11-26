# Capturing element dumps for `--boxes`

`catscan truncated`, `catscan overlap`, `catscan fit`, `catscan contrast` and `catscan untranslated --pseudo` read element boxes with
`--boxes`: one `<screen>.boxes.json` sidecar per screenshot, with each element's box and the full text
it should show. Your e2e tests already know both, so save the element dump at the same moment as the
screenshot, then convert it with `catscan boxes` ([cli.md](./cli.md#boxes)).

The converters also mark icons, images and controls `graphic: true`, opaque panels `panel: true` and
elements a scroll can still reach `scrolls: true`, which `catscan overlap` uses to check text over icons
and text cut off by a panel ([cli.md](./cli.md#boxes)). They mark tappable elements `control: true`, which
`catscan fit` uses for icon buttons and for the `control` evidence of `wrapped` (a button or tab label on two
rows): sidecars converted by an older catscan may have no `control`, so reconvert the saved dumps with
`catscan boxes` to get it. Save the base locale's screens (`en`) in the same tree, so `fit --layout` pairs
each screen with its one-row reference ([cli.md](./cli.md#wrapped-labels-and-one-word-last-rows)).

## Where files go

```
shots/
  <locale>/<screen>.png            the screenshot, full screen, never scaled or cropped
  <locale>/<screen>.<dump ext>     the element dump taken right after it (same base name)
  <locale>/<screen>.boxes.json     written by catscan boxes (see Convert the dumps)
```

- `<locale>`: a BCP 47 code: `de`, `ru`, `ja`, `pt-BR`, `ar`.
- `<screen>`: a stable screen name used in every locale (`settings`, `shop`, `level-complete`), so
  the same screen lines up across locales.
- One dump per screenshot, by extension:

| Source | Dump file | Units |
| --- | --- | --- |
| XCUITest | `<screen>.xcui.txt` | points |
| Android (UiAutomator or Espresso) | `<screen>.uia.xml` | pixels |
| Maestro | `<screen>.maestro.json` | points (iOS) or pixels (Android) |
| Playwright | `<screen>.pw.json` | CSS pixels |
| Anything else (game engine UI) | `<screen>.boxes.json` | normalized, the `--boxes` format |

**First, one of each.** Before a full run, capture one screen per framework you use and convert it,
so a wrong dump shows up before you capture them all.

## XCUITest (iOS apps)

Simulator runs share the Mac's file system, so the test can write straight into your screenshot
folder. Set `CATSCAN_CAPTURE_DIR` in the test scheme's environment (Edit Scheme > Test > Arguments)
to the absolute path of `shots/<locale>`, and launch the app in the locale under test
(`app.launchArguments += ["-AppleLanguages", "(de)", "-AppleLocale", "de_DE"]`).

```swift
func capture(_ app: XCUIApplication, _ screen: String) throws {
    guard let dir = ProcessInfo.processInfo.environment["CATSCAN_CAPTURE_DIR"] else { return }
    let base = URL(fileURLWithPath: dir).appendingPathComponent(screen)
    try FileManager.default.createDirectory(at: base.deletingLastPathComponent(), withIntermediateDirectories: true)
    try XCUIScreen.main.screenshot().pngRepresentation.write(to: base.appendingPathExtension("png"))
    try app.debugDescription.write(to: base.appendingPathExtension("xcui.txt"), atomically: true, encoding: .utf8)
}
```

Call `capture(app, "settings")` once the screen has settled (after your existing wait for its key
element). `debugDescription` lists every element with its frame in points; the converter uses the
first Window's frame as the screen.

## Android (UiAutomator or Espresso)

`UiDevice` gives both the screenshot and the hierarchy from instrumentation tests:

```kotlin
fun capture(screen: String) {
    val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null), "catscan")
    dir.mkdirs()
    device.takeScreenshot(File(dir, "$screen.png"))
    device.dumpWindowHierarchy(File(dir, "$screen.uia.xml"))
}
```

Then pull the folder into place on the Mac:

```bash
adb pull /sdcard/Android/data/<package>/files/catscan/. shots/<locale>/
```

Switch the locale per run with your test setup, or with
`adb shell cmd locale set-system-locales de-DE` (API 33+) before the run. The hierarchy is in screen
pixels, so the converter needs the screenshot (`--image`) to normalize it.

## Maestro

Take the screenshot in the flow, then dump the hierarchy with the same base name:

```yaml
- takeScreenshot: shots/de/settings
```

```bash
maestro hierarchy > shots/de/settings.maestro.json
```

## Playwright (web)

The page script collects every element with visible text, its box in CSS pixels, its full text and
whether it hides overflow, plus drawn leaves and controls (`graphic`), opaque fixed or sticky panels (`panel`) and what a
scroll still reaches (`scrolls`) for `catscan overlap`. Take the screenshot of the viewport (not `fullPage`) at the same moment:

```js
const collect = () => {
  const out = [];
  // Fields and sliders (the control kinds that passed their gate) draw a box of their own; a slider
  // role counts when no text or drawn leaf is inside.
  const drawn = "img, svg, picture, input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, [role=img]";
  const roles = "[role=slider]";
  // An opaque fixed or sticky surface is a panel; a scroll container that can still scroll makes
  // what is inside it reachable (`scrolls`); `fixed` (it or an ancestor is position: fixed) is for fullPage.
  // Chromium keeps oklch(), lab() and color() as written: their alpha follows "/"; rgb() may use a fourth number.
  const alpha = (c) => {
    const m = /^(\w+)\(([^)]*)\)$/.exec((c || "").trim()); if (!m) return 0;
    const slash = m[2].split("/"); if (slash.length > 1) return parseFloat(slash[1]) / (slash[1].includes("%") ? 100 : 1);
    const p = m[2].split(/[,\s]+/).filter(Boolean); return /^rgba?$/.test(m[1]) && p.length > 3 ? Number(p[3]) : 1;
  };
  // Room ahead only: at the scroll end a hidden label is unreachable, so it counts.
  const room = (a) => a.scrollTop + a.clientHeight < a.scrollHeight - 1 || a.scrollLeft + a.clientWidth < a.scrollWidth - 1;
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const ariaLabel = el.getAttribute("aria-label");
    const bare = !(el.innerText || "").trim() && !el.querySelector(drawn);
    const graphic = el.matches(drawn) || (el.tagName === "BUTTON" && bare) || (el.matches(roles) && bare);
    // Tappable elements, for fit's textless controls (icon buttons).
    const control = el.matches("button, a[href], input, select, [role=button], [role=tab], [role=link]");
    const cs = getComputedStyle(el);
    let fixed = false, ancestorOpacity = 1, scrolls = false;
    for (let a = el; a && a !== document.body && a.nodeType === 1; a = a.parentElement) {
      const s = a === el ? cs : getComputedStyle(a);
      if (s.position === "fixed") fixed = true;
      ancestorOpacity *= Number(s.opacity ?? 1);
      if (a !== el && /(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`) && room(a)) scrolls = true;
    }
    const panel = (cs.position === "fixed" || cs.position === "sticky") && ancestorOpacity >= 1 && ((cs.backgroundImage && cs.backgroundImage !== "none") || alpha(cs.backgroundColor) >= 1);
    // The page itself scrolls what is not fixed (or in a fixed or sticky panel).
    const se = document.scrollingElement;
    if (!fixed && se && room(se)) scrolls = true;
    if (!own && !ariaLabel && !graphic && !panel && !control) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || cs.visibility === "hidden" || cs.display === "none") continue;
    out.push({
      id: el.id || el.getAttribute("data-testid") || null,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      text: own ? (el.innerText ?? el.textContent).trim() : "", ariaLabel,
      overflow: cs.overflowX, textOverflow: cs.textOverflow,
      ...(graphic ? { graphic: true } : {}), ...(panel ? { panel: true } : {}), ...(scrolls ? { scrolls: true } : {}), ...(fixed ? { fixed: true } : {}), ...(control ? { control: true } : {}),
    });
  }
  return { viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, elements: out };
};

async function capture(page, dir, screen) {
  await page.screenshot({ path: `${dir}/${screen}.png` });
  require("fs").writeFileSync(`${dir}/${screen}.pw.json`, JSON.stringify(await page.evaluate(collect)));
}
```

The same script ships as the `playwright` converter's page script, and `@catscan/playwright` uses it
too.

## Games whose UI the accessibility tree cannot see

Unity, Unreal and canvas games often expose no elements to XCUITest or UiAutomator. Two options:

- **Write the boxes yourself** from the engine's UI tree, in the `--boxes` format ([cli.md](./cli.md#boxes))
  (`<screen>.boxes.json`): `{"image": {"width": W, "height": H}, "elements": [{"id", "box": [x, y, w, h], "text", "clips"}]}`,
  boxes normalized to 0..1 with the origin top left, `text` the full string the element should show. Optional
  fields add checks: `offscreen`, `graphic`, `panel`, `scrolls`, `control`, `enabled`, `max_lines` and more
  ([cli.md](./cli.md#boxes) lists each and the check that reads it).
- **Capture without boxes.** Such screens get only the checks that need no boxes (for `truncated`:
  ellipsis, screen edge and catalog prefix, plus `pseudo-cut` with `--pseudo`).

## Convert the dumps

Convert each dump into the sidecar next to its screenshot. Android dumps are in screen pixels, so
they need the screenshot (`--image`); iOS dumps do not:

```bash
for f in shots/de/*.xcui.txt; do catscan boxes xcuitest "$f" > "${f%.xcui.txt}.boxes.json"; done
for f in shots/de/*.uia.xml; do catscan boxes uiautomator "$f" --image "${f%.uia.xml}.png" > "${f%.uia.xml}.boxes.json"; done
for f in shots/de/*.pw.json; do catscan boxes playwright "$f" > "${f%.pw.json}.boxes.json"; done
```

Maestro dumps convert with `catscan boxes maestro`; add `--image` for Android dumps, which are in pixels.

Then point a check at the folder:

```bash
catscan truncated shots/de --locale de --boxes shots/de
```

After a catscan upgrade that adds fields to the converters, convert the saved dumps again to get them. `catscan fit` reads `control` (tappable elements, for icon buttons under a cutout or corner) and, from uiautomator dumps, `orientation`; sidecars converted before they existed still work, but `fit` then checks only text and needs `--orientation` for landscape shots. `catscan contrast` reads `enabled` (it skips text inside a disabled control) and the top-level `scale` (the device scale, written only when `--image` gives the screenshot of a dump in points: `xcuitest`, iOS `maestro`, `playwright`); without them `contrast` also judges disabled controls and takes the scale from `--scale` or the iOS screenshot size.
