/**
 * Logo Pack store (Story 8.3; FR-26, AD-25).
 *
 * Holds the bundled {@link LogoPack}, hydrated ONCE at launch via
 * `getLogoPackSafe()` (mirror `settingsStore` / the FX snapshot). The pack is
 * immutable shipped data, so this store is seeded with the EMPTY pack and loaded
 * a single time — every subscription row reads it SYNCHRONOUSLY through
 * `logoPackStore.getSnapshot().data` so `resolveLogo` runs on the render hot
 * path with no per-row IPC and nothing network-touching (AD-9).
 *
 * The fetcher never throws (a missing/corrupt bundle or an absent preload
 * resolves to {@link EMPTY_LOGO_PACK}), so the store's `error` stays null and
 * every row degrades gracefully to the deterministic lettered fallback — never
 * blank, never a spinner.
 */

import { EMPTY_LOGO_PACK, type LogoPack } from "core/logo";
import { getLogoPackSafe } from "@/api/subby";
import { createStore, type Store } from "./createStore";

/** The singleton Logo Pack store, seeded with the EMPTY pack. */
export const logoPackStore: Store<LogoPack> = createStore<LogoPack>(
  EMPTY_LOGO_PACK,
  () => getLogoPackSafe(),
);
