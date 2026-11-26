// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// The Android emulator boot flags and AVD GPU keys for scripts/e2e-maestro.mjs, kept here so a unit test guards them
// (scripts/test/e2e-maestro-emulator.test.mjs). AGENTS.md "GPU in every test": the emulator renders on the host GPU.
// Headless without `-gpu host` the emulator picks `auto`, which booted this AVD on lavapipe (CPU Vulkan).
// The rest is the measured set in plugins/catscan/skills/test-speedup/references/devices.md minus -skip-adb-auth
// (the owner's Mac is shared; the e2e keeps adb authentication), plus -no-snapshot-save.
import path from "node:path";

export const EMULATOR_FLAGS = [
  "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-gpu", "host", "-cores", "4", "-memory", "4096",
  "-camera-back", "none", "-camera-front", "none", "-no-snapshot-save",
];

export const emulatorArgs = (avd, port) => ["-avd", avd, "-port", String(port), ...EMULATOR_FLAGS];

// config.ini keys that make the AVD itself ask for the host GPU, whatever launches it.
export const AVD_GPU_KEYS = { "hw.gpu.enabled": "yes", "hw.gpu.mode": "host" };

const key = (line) => line.split("=")[0].trim();

// Returns config.ini text with AVD_GPU_KEYS set: every existing line of a key is replaced, missing keys appended.
export function withGpuHost(ini) {
  const lines = ini.trim() ? ini.replace(/\n+$/, "").split("\n") : [];
  for (const [k, v] of Object.entries(AVD_GPU_KEYS)) {
    if (lines.some((l) => key(l) === k)) lines.forEach((l, i) => { if (key(l) === k) lines[i] = `${k}=${v}`; });
    else lines.push(`${k}=${v}`);
  }
  return lines.join("\n") + "\n";
}

// The directory the emulator reads AVDs from, in the emulator's own lookup order.
export function avdHome(env, home) {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return path.join(env.ANDROID_USER_HOME, "avd");
  if (env.ANDROID_EMULATOR_HOME) return path.join(env.ANDROID_EMULATOR_HOME, "avd");
  if (env.ANDROID_SDK_HOME) return path.join(env.ANDROID_SDK_HOME, ".android/avd");
  return path.join(home, ".android/avd");
}

const value = (ini, k) => {
  const line = ini.split("\n").findLast((l) => key(l) === k);
  return line ? line.slice(line.indexOf("=") + 1).trim() : null;
};

// The AVD's own directory: the path= line of its <name>.ini descriptor (avdmanager -p moves it), else the default.
export function avdDir(home, name, descriptor) {
  const p = descriptor ? value(descriptor, "path") : null;
  return p && path.isAbsolute(p) ? p : path.join(home, `${name}.avd`);
}

// The GPU mode the emulator actually booted with: it writes hardware-qemu.ini on every boot, after any fallback.
// With GPU emulation disabled the mode line is ignored and the guest renders in software.
export function gpuModeOf(hardwareIni) {
  const enabled = value(hardwareIni, "hw.gpu.enabled");
  if (enabled !== "true" && enabled !== "yes") return `disabled (hw.gpu.enabled=${enabled})`;
  return value(hardwareIni, "hw.gpu.mode");
}
