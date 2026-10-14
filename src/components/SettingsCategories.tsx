/**
 * SettingsCategories — the Categories section for the Settings screen
 * (Story 3.4, FR-3, Req 7).
 *
 * Rendered as ONE `<SettingsSection title="Categories">` dropped into the
 * Settings scaffold via the Story-3.2 slot pattern (insert, don't restructure).
 * It gives the full category CRUD a renderer surface that previously existed only
 * at core + IPC:
 *
 *   - CREATE: an inline "Add category" field (`categoriesApi.create`), with an
 *     inline duplicate error echoing the existing name.
 *   - SET COLOR: a native `<input type="color">` per category persisting through
 *     `cat:update` (`categoriesApi.update(id, { color })`). The native picker only
 *     emits `#rrggbb`, so it never trips the boundary color validation.
 *   - CLEAR COLOR: a "Clear" button that drops the color (`color: undefined`).
 *     Because the one-time seed is marker-gated in storage, a cleared default
 *     stays cleared across reloads (never resurrected).
 *   - DELETE: a destructive button that drives the BRANDED {@link ConfirmDialog}
 *     (never `window.confirm`). Deleting an in-use category surfaces
 *     `needsConfirmation` naming the exact impact; the safe/cancel option is the
 *     focus default and the destructive confirm is non-default.
 *
 * All controls are labelled, keyboard-operable, and show visible focus rings. The
 * color dot beside each name is `aria-hidden` — the NAME carries the meaning, the
 * color is decorative. Failures from the bridge are recorded in the global
 * {@link errorStore} for a non-blocking toast; the view never crashes. The
 * renderer stays sandboxed — only `window.subby` (via `@/api/subby`) and stores.
 */

import { useState } from "react";
import { Trash2 } from "lucide-react";

import type { Category } from "core/models/category";
import { categoriesApi, isSubbyError, toAppError } from "@/api/subby";
import { categoriesStore } from "@/stores/categoriesStore";
import { errorStore } from "@/stores/errorStore";
import { useStoreData } from "@/stores/hooks";
import { SettingsSection } from "@/components/SettingsSection";
import ConfirmDialog from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";

/** Shared focus-ring utility, consistent with the app shell (Req 22.1, 22.3). */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Fallback swatch color for a colorless category's native color input. */
const COLORLESS_PLACEHOLDER = "#808080";

/** A pending delete awaiting branded confirmation (an in-use category). */
interface PendingDelete {
  id: string;
  name: string;
  inUseCount: number;
}

export default function SettingsCategories(): JSX.Element {
  const categories = useStoreData(categoriesStore);

  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  /** Record a bridge failure for the global toast (never throw out of a handler). */
  function report(err: unknown): void {
    errorStore.set(toAppError(err));
  }

  /** Create a category; a duplicate surfaces inline echoing the existing name. */
  async function addCategory(): Promise<void> {
    const name = newName.trim();
    if (name === "") return;
    setAddError(null);
    try {
      await categoriesApi.create(name);
      setNewName("");
    } catch (err) {
      // A duplicate is a `conflict` AppError; show it inline rather than globally.
      if (isSubbyError(err) && err.appError.code === "conflict") {
        setAddError(err.appError.message);
      } else {
        report(err);
      }
    }
  }

  /**
   * Set a category's color (native picker emits valid `#rrggbb`). When the
   * category was COLORLESS, the picker is seeded with the neutral placeholder; if
   * the user confirms the picker without actually changing it, the emitted value
   * still equals the placeholder — treat that as "no deliberate pick" and persist
   * nothing (so a colorless category is not silently stamped with #808080).
   */
  async function setColor(
    id: string,
    color: string,
    wasColorless: boolean,
  ): Promise<void> {
    if (wasColorless && color.toLowerCase() === COLORLESS_PLACEHOLDER) return;
    try {
      await categoriesApi.update(id, { color });
    } catch (err) {
      report(err);
    }
  }

  /** Clear a category's color — drops the key so it renders colorless. */
  async function clearColor(id: string): Promise<void> {
    try {
      await categoriesApi.update(id, { color: undefined });
    } catch (err) {
      report(err);
    }
  }

  /**
   * Begin a delete. If the category is in use, the service returns
   * `needsConfirmation` and we open the branded dialog naming the impact;
   * otherwise it is deleted immediately.
   */
  async function requestDelete(category: Category): Promise<void> {
    try {
      const result = await categoriesApi.remove(category.id);
      if (result.needsConfirmation) {
        setPendingDelete({
          id: category.id,
          name: result.name,
          inUseCount: result.inUseCount,
        });
      }
      // Not in use → already deleted (store reloads via onDataChanged).
    } catch (err) {
      report(err);
    }
  }

  /** Confirm a pending in-use delete: re-invoke with `{ confirmed: true }`. */
  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    const { id } = pendingDelete;
    setPendingDelete(null);
    try {
      await categoriesApi.remove(id, { confirmed: true });
    } catch (err) {
      report(err);
    }
  }

  return (
    <SettingsSection
      title="Categories"
      description="Create categories, set a color, or remove ones you no longer use."
    >
      {/* Existing categories */}
      {categories.length > 0 && (
        <ul className="space-y-2" aria-label="Categories">
          {categories.map((category) => (
            <li
              key={category.id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-2"
            >
              {/* Decorative color dot — the NAME carries the meaning. */}
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
                style={
                  category.color
                    ? { backgroundColor: category.color }
                    : { backgroundColor: "transparent" }
                }
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {category.name}
              </span>

              {/* Set color (native picker only emits valid #rrggbb). */}
              <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <span className="sr-only">{`Color for ${category.name}`}</span>
                <input
                  type="color"
                  aria-label={`Color for ${category.name}`}
                  className={cn(
                    "h-7 w-10 cursor-pointer rounded-md border border-input bg-background",
                    FOCUS_RING,
                  )}
                  value={category.color ?? COLORLESS_PLACEHOLDER}
                  onChange={(e) =>
                    void setColor(category.id, e.target.value, !category.color)
                  }
                />
              </label>

              {/* Clear color — only meaningful when a color is set. */}
              <button
                type="button"
                onClick={() => void clearColor(category.id)}
                disabled={!category.color}
                className={cn(
                  "inline-flex items-center rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/60 disabled:opacity-50",
                  FOCUS_RING,
                )}
              >
                Clear
              </button>

              {/* Delete — destructive red, drives the branded confirm. */}
              <button
                type="button"
                aria-label={`Delete ${category.name}`}
                onClick={() => void requestDelete(category)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-destructive/50 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 focus-visible:ring-destructive",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                )}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Add a category */}
      <div className="space-y-1.5">
        <label
          htmlFor="settings-new-category"
          className="block text-sm font-medium text-foreground"
        >
          Add category
        </label>
        <div className="flex items-center gap-2">
          <input
            id="settings-new-category"
            type="text"
            className={cn(
              "w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
              FOCUS_RING,
            )}
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              if (addError) setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addCategory();
              }
            }}
            placeholder="e.g. Newsletters"
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? "settings-new-category-error" : undefined}
          />
          <button
            type="button"
            onClick={() => void addCategory()}
            className={cn(
              "inline-flex shrink-0 items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90",
              FOCUS_RING,
            )}
          >
            Add
          </button>
        </div>
        {addError && (
          <p
            id="settings-new-category-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {addError}
          </p>
        )}
      </div>

      {/* Branded in-app confirmation for deleting an in-use category. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete category?"
        message={
          pendingDelete
            ? `"${pendingDelete.name}" is used by ${pendingDelete.inUseCount} subscription${
                pendingDelete.inUseCount === 1 ? "" : "s"
              }. Deleting it leaves those subscriptions uncategorized. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </SettingsSection>
  );
}
