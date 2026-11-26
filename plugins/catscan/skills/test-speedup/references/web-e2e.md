# Web e2e (Playwright, headless Chrome)

## Levers, in order

1. **GPU rendering, at every launch site.** chrome-headless-shell defaults to SwiftShader: every WebGL/canvas frame is drawn on the CPU. On macOS pass `--use-angle=metal` (Linux with a GPU: `--use-angle=vulkan` or `--use-gl=egl`, verify). Expect frame time to drop by an order of magnitude on canvas-heavy pages. The misses are rarely the Playwright config: they are direct `chromium.launch()`, `launchPersistentContext`, `launchServer`, `_electron.launch()` and puppeteer calls in scripts and tools (bake, store art, screenshots, bench, spike). Route every one through one shared helper (below), lock it with the guard, prove it with the renderer smoke spec (`guards.md`, GPU). Where no GPU exists (a Linux runner, a VM) SwiftShader is the working fallback: the helper adds nothing there and the smoke spec warns instead of failing; on a machine with a GPU, SwiftShader is only the per-run env opt-out `E2E_GPU=swiftshader`.
2. **Polling interval.** `expect.poll` and `toPass` back off to 1 s between checks and this has no config setting. Wrap: `expect.poll(fn, { intervals: [50] })` through a shared helper so every spec uses it. Note: copies made by `expect.soft`, `expect.configure()` and `expect.extend()` keep the default back-off.
3. **Workers and long specs.** Measure 2, 3, 4 workers with `fullyParallel: true`; more is not always faster on a shared host. Put real-clock or long specs in their own project that starts first, so they do not strand at the end.
4. **Virtual clock.** If the app has timers, animations or game beats, add a test-only manual clock (`?clock=manual`, `advance(ms)`, `until(pred)`) and drive it from tests. Specs that must use real time are listed explicitly and every wall-clock read in app code carries a `real-clock:` comment checked by a lint test. Prove equivalence: one seeded scenario run on the manual and the real clock must give the same result.
5. **Boot once per setup.** One page boot per identical setup, read state as soon as it is ready instead of after a fixed settle.
6. **Isolated servers.** A free port per run (`--strictPort`), never `reuseExistingServer` with a fixed port: parallel worktrees otherwise test each other's build.

## GPU helper, launch sites and the renderer check

One helper in the project's shared test utilities; every launch passes its args:

```js
import { execFileSync } from 'node:child_process';
// GPU args for every Chromium and Electron launch (agent rule: GPU in every test). Linux and Windows get no
// Metal flag: headless Chromium there renders WebGL with SwiftShader, slower but correct.
export function gpuLaunchArgs({ platform = process.platform, env = process.env } = {}) {
  if (env.E2E_GPU === 'swiftshader') return ['--use-angle=swiftshader']; // gpu-launch: per-run env opt-out
  return platform === 'darwin' ? ['--use-angle=metal'] : [];
}
// Where the smoke spec must see a GPU: a physical Mac. A VM (a hosted macOS runner) or another OS warns instead.
export function gpuExpected({ platform = process.platform, env = process.env } = {}) {
  if (env.E2E_GPU === 'swiftshader' || platform !== 'darwin') return false;
  try { return execFileSync('sysctl', ['-n', 'kern.hv_vmm_present'], { encoding: 'utf8' }).trim() === '0'; } catch { return true; }
}
```

Playwright config: `use: { launchOptions: { args: gpuLaunchArgs() } }` (or in each Chromium project).
Scripts: `chromium.launch({ args: gpuLaunchArgs() })`, `chromium.launchPersistentContext(dir, { args: gpuLaunchArgs() })`.
Electron: `electron.launch({ args: [...gpuLaunchArgs(), 'main.js'] })`. WebKit and Firefox take no flag.

A flag in the source proves nothing when the launch path drops it. Checked on macOS 27.2.1, Apple M5, Playwright 1.65.0 (Chromium 158), Electron 45.2.3 (2026-11-16):

| Launch | Unmasked WebGL renderer |
| --- | --- |
| headless shell (`chromium.launch()`), no flag | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...), SwiftShader driver)` |
| headless shell or persistent context, `--use-angle=metal` | `ANGLE (Apple, ANGLE Metal Renderer: Apple M5, ...)` |
| new headless (`channel: 'chromium'`), with or without the flag | Metal |
| `--use-angle=metal` plus `--disable-gpu` | SwiftShader (`--disable-gpu` wins) |
| Electron, no flag or `--use-angle=metal` | Metal; with `--disable-gpu`: no WebGL context at all |

So one smoke spec runs through the helper and fails on a CPU renderer where a GPU exists. `gl.RENDERER` alone says `WebKit WebGL`; read the unmasked one. Put it where the e2e suite runs it (a `*.spec.*` file):

```js
import { test, expect } from '@playwright/test';
import { gpuExpected } from './gpu.mjs'; // the helper module above
const CPU_RENDERER = /SwiftShader|llvmpipe|softpipe|Software Rasterizer|Microsoft Basic Render/i;
test('WebGL draws on the GPU where one exists', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'the GPU args are Chromium flags');
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no WebGL context';
  });
  const cpu = renderer === 'no WebGL context' || CPU_RENDERER.test(renderer);
  if (cpu && !gpuExpected()) {
    // No host GPU (Linux runner, a VM) or E2E_GPU=swiftshader: the CPU is the expected fallback, never a failure.
    test.info().annotations.push({ type: 'warning', description: `CPU renderer, no host GPU here: ${renderer}` });
    return;
  }
  expect(renderer).not.toBe('no WebGL context');
  expect(renderer).not.toMatch(CPU_RENDERER);
});
```

It fails only when the flag was ignored on a machine with a GPU (the case that matters) and warns on GPU-less CI. Whether a hosted macOS runner (a VM) gives WebGL a Metal device is unverified: `gpuExpected()` treats every VM as GPU-less, so such a run warns and passes. A Linux runner with a GPU can return `['--use-angle=vulkan']` (or `--use-gl=egl`) and `true` from both helpers once checked there.

For Electron run the same function through `(await electronApp.firstWindow()).evaluate(...)`.

## Traps
- A faster renderer exposes tests tuned to SwiftShader's pace (race with simulated loads). Fix the test, do not slow the renderer.
- Two Playwright commands of one app at once share `test-results/` and fail with ENOENT on traces. Give each its own `outputDir`.
- A test hook that resumes `requestAnimationFrame` beside a manual clock reintroduces real time and flakes.
- A loop over locales inside one test times out under load; split per locale.
- Chromium may stamp the next frame mid-block: a long-frame assertion should sum neighbouring frames.

## Bar
Wall time per game/app suite and CPU per run, before and after, at a recorded load. Guard: `scripts/gpu-guard.mjs` + renderer smoke spec (`guards.md`, GPU), config-shape test (poll helper, ports) + fixed-wait ratchet.
