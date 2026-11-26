# Android emulators, iOS simulators, Maestro

## One launcher
The Maestro section applies only to Maestro; a custom adb or CDP runner follows the same rules (one device per run, preconditions first, kill stale drivers, retry only named infra errors).
All device boots go through one script: flags, snapshot, lock, settle, device cap. A guard test fails on any other boot path in the repo (`emulator -avd`, `xcrun simctl boot` outside the launcher). Without it every session boots by hand with different flags and no number is comparable. Enforce a machine-wide cap on simulators + emulators + Metro servers (a hook or the launcher refuses past it). The launcher takes one lock per device set (the emulators it boots together are one set), queues waiting runs in arrival order, prints the holder (command, pid, start time) while it waits, takes over a lock whose holder is dead, and has a `--no-wait` that exits non-zero instead of queueing. A second run just calls the launcher: never a wait loop over `pgrep` or `ps | grep`, which can match the loop itself or succeed on empty input and never end.

## Android emulator

### Boot flags
`-no-window -no-audio -no-boot-anim -no-metrics -gpu host -cores 4 -memory 4096 -camera-back none -camera-front none -skip-adb-auth`
- `-gpu host`: headless `-gpu auto` (or `swiftshader_indirect`) renders on the CPU: jank, flaky `scrollUntilVisible`, missed swipes. On Apple silicon `host` is ANGLE on Metal. Guard: `gpu-guard.mjs` (`guards.md`) fails on an AVD boot without it (name a flag constant with `--helper`); an AVD's own `config.ini` needs `hw.gpu.enabled=yes` and `hw.gpu.mode=host` for hand boots. Runtime check: `adb shell dumpsys SurfaceFlinger | grep GLES:` shows `Android Emulator OpenGL ES Translator (Apple M5) ... Metal` on the GPU (seen 2026-11-16) and names SwiftShader on the CPU.
- `-memory 4096`: a 2 GB guest reboots under host load.

### Per environment (GPU-less CI)
- **macOS (a local Mac or a Mac runner):** `-gpu host` by default. A CPU renderer (`-gpu swiftshader_indirect`, or headless `auto`) works there, slower and with more jank, and stays the per-run env opt-out (`E2E_GPU=swiftshader` maps to it on a line with the owner's `gpu-launch:` comment).
- **A Linux cloud VM without a GPU:** in a tested private setup (an N4D CPU-only VM on GCP, gfxstream, emulator 37.2.13), `-gpu swiftshader_indirect` aborted `surfaceflinger` 16 times and `-gpu guest` twice; Google marks `swiftshader_indirect` deprecated (private measurement notes `remote-emulators-gcp.md` §10a, at f1e7f35b6). Observed on that setup, not a universal fact: use a GPU VM (below) or route the run to another slot.
- **Unknown CI:** detect before booting (`nvidia-smi`, `/dev/dri/renderD*`, `sysctl -n kern.hv_vmm_present` on a Mac), check the renderer after boot (`dumpsys SurfaceFlinger`, above), and write in the report what was verified on which host.

### Cloud GPU VM
- Works: `-gpu host` on `g2` + L4 and `n1` + T4, from the Deep Learning VM NVIDIA image with the GL and Xorg packages, a headless Xorg on the GPU, and a udev rule that keeps `/dev/kvm` at mode 0666.
- Limits: one emulator per GPU VM (two share a GL context and crash); pin emulator 37.3.9.0 (earlier builds froze the guest on an app kill); API 36.0 on a Linux host (36.1 aborts `surfaceflinger`); snapshots under `-gpu host` need `-feature -Vulkan`.
- Cost and time, measured there: about $0.10 a run on T4 Spot, 15.9 min from create to end against 7.5 min on the Mac.
- Guards: a billing-account check before any create, `--max-run-duration` with `--instance-termination-action=DELETE`, and a fallback cascade (T4 Spot, L4 Spot, on-demand) that ends on the local slot.

### Suite snapshot
Boot once with `-no-snapshot-load -no-snapshot-save`, apply the cleanup below, settle, then `adb emu avd snapshot save <suite>_e2e`. Later runs wake from it with `-read-only`. Stamp the snapshot with: emulator version, system image, boot flags, the disabled-app list, `config.ini` hash. Any change re-saves it. Guard the save with a pid+token lock that goes stale after about 10 min. If the AVD is in use elsewhere, boot cold instead of waiting.

### Service cleanup (in the snapshot AND again in every instance)
```
pm disable-user --user 0 com.google.android.as
pm disable-user --user 0 com.google.android.apps.messaging
pm disable-user --user 0 com.google.android.dialer
pm disable-user --user 0 com.google.android.googlequicksearchbox
pm disable-user --user 0 com.google.android.settings.intelligence
pm disable-user --user 0 com.android.vending      # Play Store: updates Play services mid-run and kills the app
locksettings set-disabled true                    # keyguard returns under load otherwise
input keyevent 82
settings put secure immersive_mode_confirmations confirmed
```
Verify each with `pm list packages -e`. Why both places: a woken snapshot replays hours of missed Google jobs during the test (guest load 30-54, ANRs, WebView missing its 30 s attach). If the app tests Play Billing, re-enable `com.android.vending` per instance after boot.

Decision: do NOT set the three `*_animation_scale` keys to 0 when tests or screenshots judge motion; 0 hides it. On reused AVDs, reset animation scales, `font_scale` and `wm density` to defaults instead, so a previous session's settings do not leak.

### Settle by state, with a deadline (up to 60 s)
Poll: clock synced, network VALIDATED, `pm path android` answers, no `pidof dex2oat*`, plus any backend host the app needs. Never a fixed sleep.

### Builds and lanes
- Gradle heap for many native modules: `-Xmx6144m -XX:MaxMetaspaceSize=1024m` (template default 2 GB runs javac out of memory with ~14 Expo modules). Persist through prebuild with a config plugin.
- Parallel lanes: one debug APK per Metro port, `-PreactNativeArchitectures=arm64-v8a -PreactNativeDevServerPort=<port>`, `adb install -r` keeps app data. About 20 s per build after the first.
- Warm Gradle cache: 0.5 min warm vs 6.5 min cold under load.

### Scope scenarios
Tag each device scenario: runs on any one screen, phone only (frame times), full sweep only (locales). Move what the page or a unit test can prove down a layer; before adding a device scenario, search the unit and web e2e tests for the same claim (the event, state or text name) and extend that test instead. Boot two emulators in parallel only when no web e2e is running; at high host load they miss swipes and ANR.

## iOS simulator

The simulator draws through Metal on the host GPU and has no CPU renderer switch, so the GPU guard has nothing to check here; record `gpu` in the inventory. A WebView inside it uses the same GPU.

| Lever | Detail |
| --- | --- |
| Reuse a booted named device | One simulator per session, never erase. Reuse of a booted one costs about 6 s, a reboot 14 s, a fresh device about 50 s. |
| Warm template clone | Keep a stock simulator that has finished first-boot work; `simctl clone` it for a new device (129 -> 87 s to settled, 39% less CPU). Clone refuses a booted source. |
| Settle detection | After `simctl bootstatus -b`, wait until the device averages under 0.25 cores over 15 s. |
| Service cleanup (measured, shipped in one repo) | Disable daemons the app never uses in each new clone before its first boot; details below. Measured with 47 labels on iOS 27.0 clones: memory 9.9 -> 6.4 GB, processes 224 -> 155, CPU in the first 180 s 389 -> 279 core-s, settled 100 -> 76 s. No sudo, no host `launchctl unload`, no third-party slimming tools. |

Service cleanup, step by step:
- Where: an XML plist with `<key><label></key><true/>` per label at `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<UDID>/disabled.plist` (directory mode 700). `launchd_sim` reads it at boot. `simctl clone` does not copy it; `launchctl disable` inside a booted device writes the same file but needs a second boot. So write it for the shut-down clone, at no boot cost.
- Write it to a temp name and rename it into place, so a boot never reads a half-written file. Refuse a UDID that is not a UUID.
- Check: after boot, `xcrun simctl spawn <udid> launchctl print-disabled system` lists all N labels as disabled, and `launchctl list` shows fewer jobs (107-110 vs 144 stock in the measured case), or the lever did nothing.
- Apply the list only to the runtime builds it was checked on (`simctl list runtimes -j`, `buildversion`); any other runtime boots stock until someone re-checks it. Give an opt-out switch (an environment variable) that boots stock.
- Seen on iOS 27.0: never disable `com.apple.nanoregistryd` (boot hangs at "Waiting on BackBoard") or `com.apple.sleepd` (SpringBoard spins at about one core and the device never settles).
- `simctl delete` leaves the directory behind (about 15 MB of launchd logs per booted device). Leave it: the shipped launcher removes nothing and accepts the leak. Other device sets (Xcode test devices) keep live directories in the same folder, and a failed or raced delete would take a live device's list with it. Never sweep the folder. The OS may prune `/private/var/tmp`, which silently reverts a long-lived device to stock: re-check it or prefer clones.
- Commit the list as data with tests: every label written, the two traps absent, the atomic write, the runtime allowlist, the opt-out. Any list change needs a boot and idle check and a run of the app's flows.

Set a separate bar for memory, processes and CPU before the run, and judge each on its own. A memory cut that meets its bar is a win even when CPU rises (memory is the scarce resource on a shared host); a CPU rise from the same lever is a separate defect to find and remove, usually one item of a list: find the process that spins, then bisect the list: per step a fresh clone with the plist written before first boot, and a 20 s CPU sample taken at least 150 s after boot (a stock clone settles in about 100 s). A device that never settles inside the window is reported as "not settled in <window> s", never as a time.

## Maestro hygiene
- Kill a stale Maestro JVM on its port (7001) before each run instead of retrying `DEADLINE_EXCEEDED` / "Unable to launch app". Pin a Maestro version without the port-forwarding bugs.
- One flow file at a time per device. Directory mode runs a directory's flows in parallel and they collide on one emulator. Refuse to start when more than one device is attached and no UDID is pinned.
- Preconditions fail fast: device awake and unlocked, `adb reverse` for Metro, Metro listening. Or use a release-like build with the bundle embedded, which removes Metro from the failure surface.
- Retry once only for named infra errors, after `--reinstall-driver`. Never retry app or API failures.
- `optional: true` waits spend their whole timeout when the target never shows: keep their timeouts short and count them in the fixed-wait ratchet. Anchor on stable testIDs, not localized copy.

## Release reuse
A full device report counts for a later commit when the tree was clean, every check passed, scope was full, and the app's input hash is unchanged.

## Bar
Boot time, boot+first-flow time, frame stats (frames drawn, p90 frame time, janky %), CPU core-seconds to settle, memory (sum of `phys_footprint`) and process count for service levers, host load. Guards: launcher-only test, snapshot stamp, fixed-wait ratchet on flow files.
