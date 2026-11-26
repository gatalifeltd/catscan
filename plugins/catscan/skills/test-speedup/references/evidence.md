# Evidence from three production repos (2026)

Field measurements from three private production repos, on a shared Apple-silicon Mac under load unless noted. They are not reproducible from this package; the lab keeps a source map (repo, commit, file:line, tool versions). Use them to calibrate expectations, not as promises. A row that names several levers gives the range for the bundle; the share of one lever in it is unknown.

| Layer | Lever | Before -> after |
| --- | --- | --- |
| CI | Required CI cut to install-free jobs | ~9 min -> ~1 min per PR; 29 jobs -> 1 |
| CI | Size gates off root `package.json` | -34 s gate, -83-147 s job per PR |
| CI | Restore-only PR caches, Metro export relevance in code | ~2.5-3 billed min per PR saved |
| CI | Nightly warm split | ~500 -> 100-150 min/month target |
| CI | Turbo concurrency 10 -> 4 on 2 vCPU, 2 workers | one suite 51.2 s -> 27.4 s |
| Android | `-gpu host` instead of headless auto | frames 78 -> 421; p90 frame 200 -> 30 ms; janky 98.7% -> 1.8% |
| Android | Suite snapshot | boot 27.3 -> 6.4 s; cold 45-85 s -> 3-10 s |
| Android | GPU + snapshot + 4 GB, full device runs | 520 -> 390 s, 270 -> 200 s |
| Android | Disabled apps + settle by state | settled in 8.8-18.3 s at host load 40-80 |
| Android | Device scenario scoping | 61.1 -> 23.9 min for four apps; 68 -> 40 scenario runs |
| Android | Warm Gradle | 6.5 -> 0.5 min |
| iOS | Warm template clone | settled 129 -> 87 s, 39% less CPU |
| iOS | Reuse booted device | 50 s first boot vs 6 s reuse |
| iOS | 47 services disabled before a clone's first boot (iOS 27.0; shipped; boot and idle checked, app flows not run) | memory 9.9 -> 6.4 GB; CPU first 180 s 389 -> 279 core-s; settled 100 -> 76 s; jobs 144 -> 107-110 |
| iOS | Same list plus `sleepd` (48) | memory 61% of stock, but CPU +35% and never settled in 240 s |
| Web e2e | WebGL on Metal | frame ~120 -> 16.5 ms |
| Web e2e | GPU + 4 workers + long-spec project | 732 -> 381 s, 1530 -> 681 s, 220 -> 115 s |
| Web e2e | `expect.poll` every 50 ms | summed 2915 -> 2640 s; one test 31.5 -> 8.2 s |
| Web e2e | Virtual clock | 6.1 -> 2.5 min, 2.2 -> 1.0 min, 54 -> 32 s |
| Web e2e | Waits on state instead of settles | warmup 70 -> 20 s; 255 -> ~111 s |
| Unit | Turbo explicit inputs + guard split | warm ~22 s / 97 s CPU -> ~5 s / 25 s CPU |
| Unit | Turbo cache first introduced | cold 70 s vs warm 16.4 s |
| Unit | Gate result cache | 8 steps on the same commit: 5.7 s |
| Unit | Assert once in loops | 5.6 -> 0.6 s; 6.9 -> 0.06 s; 559 -> 9 ms |
| Unit | One ESLint child per file | 30 -> 10 s CPU |
| Unit | Algorithm fixes in code under test | 102 -> ~50 s; 62 -> 41 s; 6.8 -> 0.3 s |
| Unit | `cores - 1` worker ceiling (anti-pattern) | 1.87x slower critical path on 2 vCPU |
