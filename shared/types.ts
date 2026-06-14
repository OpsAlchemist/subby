/**
 * Shared IPC request/response contracts (design: shared/types.ts).
 *
 * These types cross the renderer↔main IPC bridge. They are platform-independent
 * and reference only `core/models` types. Every IPC handler returns a
 * discriminated `IpcResult<T>` so exceptions never cross the bridge (Req 19).
 */

import type { Subscription } from "core/models/subscription";

/** Discriminated result returned by every IPC handler (Req 19). */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

/** User-friendly error surfaced to the renderer (Req 19). */
export interface AppError {
  code: "validation" | "io" | "corrupt" | "conflict" | "not_found" | "unknown";
  message: string; // user-friendly
  field?: string; // e.g. "name", "amount" for validation
  file?: string; // affected file for io/corrupt
  canRestoreBackup?: boolean;
}

/**
 * Fields supplied by the user when creating a subscription.
 * System-managed fields (`id`, `createdAt`, `updatedAt`) are assigned by core.
 */
export type SubscriptionInput = Omit<
  Subscription,
  "id" | "createdAt" | "updatedAt"
>;

/** Conflict resolution mode used during import (Req 16.3). */
export type ConflictMode = "Replace" | "Merge" | "Skip";

/** Request payload for `data:import` (Req 16). */
export interface ImportRequest {
  format: "json" | "csv";
  conflictMode: ConflictMode;
  path: string;
}

/** Request payload for `data:export` (Req 17). */
export interface ExportRequest {
  format: "json" | "csv";
  path: string;
}
