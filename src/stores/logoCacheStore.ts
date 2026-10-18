/**
 * Logo cache store (Story 8.4; AD-13).
 *
 * Holds the fetched-logo cache as a domain→`data:<mime>;base64,…` map, hydrated
 * via `getLogoCacheSafe()`. UNLIKE the load-once {@link logoPackStore} (immutable
 * shipped data), this store is RELOADED on every `evt:dataChanged` — it is part
 * of the `onDataChanged` reload set — because the EnrichmentService broadcasts
 * that event after persisting a newly fetched logo. So a logo fetched in the
 * background swaps in on the next broadcast with no fs access in the renderer:
 * the sandboxed renderer only ever sees a plain data-URI string, which
 * `resolveLogo`'s cache tier renders synchronously as an `<img src>`.
 *
 * The fetcher never throws (an absent preload / unreadable cache resolves to an
 * empty `{}` map), so the store's `error` stays null and every row simply falls
 * back to the bundled pack or the lettered tile — never blank, never a spinner.
 * The map is EMPTY for real users this story (live fetch is off until 8.5).
 */

import { getLogoCacheSafe } from "@/api/subby";
import { createStore, type Store } from "./createStore";

/** The singleton logo cache store, seeded empty and reloaded on data change. */
export const logoCacheStore: Store<Record<string, string>> = createStore<
  Record<string, string>
>({}, () => getLogoCacheSafe());
