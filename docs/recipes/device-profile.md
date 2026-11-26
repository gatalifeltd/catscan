# Write a device profile

`catscan fit` checks text and icon buttons against a device's hidden zones: the camera cutout, the rounded corners and the home indicator or gesture handle. catscan ships profiles for the iPhone and iPad simulators of the current Xcode and the Pixel phones of the Android emulator (`catscan fit --list-devices`). For any other device, write a profile file with the steps below and pass it to `--device-profile`:

```bash
catscan fit shots/android --device-profile profiles/pixel-9.json --experimental
```

`fit` is experimental: it runs only with `--experimental` or with the reasons named in `--reasons` ([`cli.md`](../cli.md#fit)).

A profile is measured with the platform's own public APIs on the device or emulator that takes the screenshots. Nothing is copied from device skins or mask files.

## The format

```json
{
  "device_profile": 1,
  "id": "pixel-9",
  "name": "Pixel 9",
  "platform": "android",
  "screen": { "width": 1080, "height": 2424 },
  "measured": { "tool": "API 36 emulator", "date": "2026-11-20", "script": "PixelProfileTest" },
  "zones": [
    { "kind": "cutout", "runs": [[40, 512, 568], [41, 508, 572]] },
    { "kind": "corner", "runs": [[0, 0, 96], [0, 984, 1080]] },
    { "kind": "home-indicator", "box": [414, 2376, 252, 12] }
  ],
  "landscape": { "home-indicator": { "box": [1086, 1032, 252, 12] } }
}
```

- All geometry is in the portrait screenshot's pixels, origin top left. `screen` is the portrait size.
- `runs` are hidden pixel runs `[y, x0, x1)`: on row `y`, pixels `x0` up to (not including) `x1` are hidden. Give as many runs per row as the shape needs.
- `box` is `[x, y, width, height]`. The home indicator moves when the device turns, so its landscape box is given separately, in landscape pixels; a profile with a `home-indicator` zone must have it.
- A device with no cutout, rounded corner or home indicator has `"zones": []`.
- The JSON Schema is `core/schema/device-profile.schema.json` in the catscan repository. catscan checks every field and names the first wrong one (`invalid-device-profile`).

## Android: an instrumentation test

Add this test to the app's `androidTest` sources and run it on the device or emulator that takes the screenshots. It reads the cutout path, the rounded corners and the gesture insets that Android gives every app, and writes the profile to the test's output folder.

```kotlin
@RunWith(AndroidJUnit4::class)
class DeviceProfileTest {
    @get:Rule val rule = ActivityScenarioRule(ComponentActivity::class.java)

    @Test fun writeProfile() = rule.scenario.onActivity { a ->
        val insets = a.window.decorView.rootWindowInsets
        val m = a.windowManager.currentWindowMetrics.bounds
        val (w, h) = minOf(m.width(), m.height()) to maxOf(m.width(), m.height())
        val zones = JSONArray()
        fun runs(path: Path?, kind: String) {
            if (path == null || path.isEmpty) return
            val region = Region().apply { setPath(path, Region(0, 0, w, h)) }
            val out = JSONArray()
            for (y in 0 until h) for (seg in rowRuns(region, y, w)) out.put(JSONArray(listOf(y, seg.first, seg.second)))
            if (out.length() > 0) zones.put(JSONObject().put("kind", kind).put("runs", out))
        }
        runs(insets.displayCutout?.cutoutPath, "cutout")
        val corners = Path()
        for (pos in listOf(RoundedCorner.POSITION_TOP_LEFT, RoundedCorner.POSITION_TOP_RIGHT, RoundedCorner.POSITION_BOTTOM_LEFT, RoundedCorner.POSITION_BOTTOM_RIGHT)) {
            val c = insets.getRoundedCorner(pos) ?: continue
            corners.op(cornerPath(c, w, h), Path.Op.UNION)
        }
        runs(corners, "corner")
        val g = insets.getInsets(WindowInsets.Type.mandatorySystemGestures())
        if (g.bottom > 0) zones.put(JSONObject().put("kind", "home-indicator").put("box", JSONArray(listOf(w / 2 - g.bottom * 2, h - g.bottom, g.bottom * 4, g.bottom))))
        val profile = JSONObject().put("device_profile", 1).put("id", Build.MODEL.lowercase().replace(Regex("[^a-z0-9]+"), "-"))
            .put("platform", "android").put("screen", JSONObject().put("width", w).put("height", h)).put("zones", zones)
        // The handle moves to the bottom of the landscape frame (h wide, w tall); a home-indicator zone needs this box.
        if (g.bottom > 0) profile.put("landscape", JSONObject().put("home-indicator", JSONObject().put("box", JSONArray(listOf(h / 2 - g.bottom * 2, w - g.bottom, g.bottom * 4, g.bottom)))))
        File(a.getExternalFilesDir(null), "device-profile.json").writeText(profile.toString())
    }
}
```

`rowRuns` walks one row of the region and returns its `[x0, x1)` spans; `cornerPath` returns the area outside the rounded corner's arc (the square of side `radius` at that corner minus the quarter circle around `center`). Pull the file with `adb pull /sdcard/Android/data/<package>/files/device-profile.json`, then check it:

```bash
catscan fit shot.png --device-profile device-profile.json --experimental
```

The gesture handle box above is the gesture inset's band, narrowed to its middle; if your launcher draws the handle elsewhere, take its box from a screenshot of a white screen and edit `box` and the `landscape` box.

## iOS: a device type catscan does not ship

The shipped table covers every iPhone and iPad simulator of the Xcode it was measured on. For a newer device type, measure it with the same probe on the simulator: in a clone of the catscan repository,

```bash
node bench/devices/ios-profiles.mjs --only '^iPhone 18 Pro$' --out profiles/iphone-18-pro.json
```

The script boots one simulator, runs a white full-screen probe app, and compares `xcrun simctl io screenshot --mask=black` with `--mask=ignored`: the pixels the mask hides are the cutout and the corners. It writes a table; copy the one profile object out of `profiles` into its own file. iOS leaves the home indicator out of every screenshot and recording, so iOS profiles have no `home-indicator` zone; add a `box` by hand if you know it, with its `landscape` box (required with a `home-indicator` zone).
