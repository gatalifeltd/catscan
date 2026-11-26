// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Hand-written types. The matchers augment PlaywrightTest.Matchers, so they type-check on
// `expect(page)` and `expect(locator)` from this package or from an `expect.extend(catscanMatchers())`.
import type { Expect, Locator, Page } from "@playwright/test";

export interface CatscanOptions {
  /** Screen locale (BCP 47). Default: the page's navigator.language (the context locale), else en. */
  locale?: string;
  /** Catalog file or files; `{locale}` takes the resolved catscan locale. Enables `@key`. */
  catalog?: string | string[];
  /** Reader for locales Vision cannot read. Default: Tesseract when installed. */
  fallback?: "tesseract" | "none";
  /** Milliseconds. Default: the project's expect timeout. */
  timeout?: number;
  /** Locators painted over before the screenshot is read. */
  mask?: Locator[];
  /** Text (or `@key`) the matcher waits for before its check; `false` says the first frame is ready. */
  readyText?: string | false;
}

export interface PageOptions extends CatscanOptions {
  /** Page only: the whole scrollable page. */
  fullPage?: boolean;
}

export interface LocatorOptions extends CatscanOptions {
  fullPage?: never;
}

export interface AllowOption {
  /** Lines never reported. */
  allow?: string[];
}

export interface BaseOption {
  /** The base-locale catalog (`untranslated --base`); needs `catalog`. */
  base?: string;
}

export interface ThresholdOptions {
  /** Only findings at or above this severity fail the matcher. Default "minor": every finding. */
  minSeverity?: "critical" | "major" | "minor";
  /** Only findings at or above this certainty fail the matcher. Default "low": every finding. */
  minCertainty?: "high" | "medium" | "low";
}

export interface PseudoOption {
  /** The page shows a pseudo-locale build (`catscan pseudo`, `--pseudo`): catalog is the base catalog, en-XA reads as en. */
  pseudo?: boolean;
}

export interface ScreenOption {
  /** With a save folder: the screen name of this call's saved shot, instead of the one made from the test title. */
  screen?: string;
}

type Opts<T, Extra = {}> = (T extends Locator ? LocatorOptions : PageOptions) & ScreenOption & Extra;

export interface CatscanDefaults extends PageOptions, AllowOption, BaseOption, PseudoOption, ThresholdOptions {
  /** Off macOS on Apple silicon, or with no binary: "throw" (default) or "skip" (test.skip()). */
  onUnsupported?: "throw" | "skip";
  /** Folder for each checked screenshot and its element boxes, for the CLI checks after the run. Default: CATSCAN_SAVE_DIR, else off; false: off. */
  saveDir?: string | false;
}

declare global {
  namespace PlaywrightTest {
    interface Matchers<R, T = unknown> {
      /** Every text is visible in the screenshot (`check --present`); `.not` checks each is absent. */
      toShowText(text: string | string[], options?: Opts<T, PseudoOption>): Promise<R>;
      /** No visible text is cut off (`truncated`, with the page's element boxes). */
      toHaveNoTruncation(options?: Opts<T, AllowOption & PseudoOption & ThresholdOptions>): Promise<R>;
      /** No text is drawn over other text or an icon (`overlap --boxes`, with the page's element boxes); allow takes element ids or texts. */
      toHaveNoOverlap(options?: Opts<T, AllowOption & ThresholdOptions>): Promise<R>;
      /** No raw key, unfilled placeholder or (with base and catalog) base-locale string is shown. */
      toHaveNoUntranslated(options?: Opts<T, AllowOption & BaseOption & PseudoOption & ThresholdOptions>): Promise<R>;
    }
  }
}

/** Matchers for `expect.extend()`; their types come from the PlaywrightTest.Matchers augmentation above. */
export declare function catscanMatchers(defaults?: CatscanDefaults): {};

/** Playwright's expect with the catscan matchers. */
export declare const expect: Expect<{}>;

export declare class CatscanError extends Error {
  code: string;
  hint?: string;
  anchor?: string;
}

export declare class CatscanUnsupportedPlatformError extends CatscanError {}
