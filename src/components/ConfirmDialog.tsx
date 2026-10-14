/**
 * ConfirmDialog — a small branded in-app confirmation dialog (Story 3.4).
 *
 * The one destructive-confirm primitive the app uses INSTEAD of the native
 * `window.confirm` (DESIGN "Branded confirmation"): a centered `alertdialog` over
 * a dimmed backdrop, re-using the Add/Edit modal tokens. It is introduced here
 * because category delete needs it now, and Story 3.5's bulk delete reuses it —
 * building it once avoids a later retrofit (epic "a11y designed in once").
 *
 * Accessibility (matches the modal in `SubscriptionModal.tsx`):
 *   - `role="alertdialog"` + `aria-modal="true"`, labelled by its title and
 *     described by its message.
 *   - Focus is trapped within the dialog; the SAFE/cancel button is the focus
 *     default (lands focus on open), and the destructive action is NON-default
 *     (never the focus default, so an accidental Enter cancels rather than
 *     destroys).
 *   - Escape and a backdrop click both CANCEL (the safe outcome).
 *   - Focus returns to the previously focused element on close.
 *   - The destructive button carries its own destructive styling + focus ring,
 *     never the accent (delete must never blur with primary).
 *
 * The dialog renders nothing when `open` is false, so a parent can keep it
 * mounted and toggle `open`.
 */

import { useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

/** Shared focus-ring utility, consistent with the app shell (Req 22.1, 22.3). */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export interface ConfirmDialogProps {
  /** Whether the dialog is rendered/open. */
  open: boolean;
  /** The dialog title (its accessible name). */
  title: string;
  /** The body message naming the exact impact of the action. */
  message: string;
  /** Label for the destructive confirm button (e.g. "Delete"). */
  confirmLabel: string;
  /** Label for the safe/cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Invoked when the user confirms the destructive action. */
  onConfirm: () => void;
  /** Invoked on cancel, Escape, or backdrop click (the safe outcome). */
  onCancel: () => void;
}

/**
 * A focus-managed branded confirmation dialog. The cancel option is the focus
 * default; the destructive action is non-default. Esc / backdrop cancel.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  /** Focus management: land focus on the SAFE button; restore focus on close. */
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const id = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  /** Escape cancels; Tab is trapped within the dialog. */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key === "Tab") {
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div
      // Backdrop: a click on the scrim cancels (the safe outcome).
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p id={messageId} className="mt-2 text-sm text-muted-foreground">
          {message}
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          {/* Safe/cancel is the focus default and the visual default. */}
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className={cn(
              "inline-flex items-center rounded-lg border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary/60 focus-visible:ring-ring",
              FOCUS_RING,
            )}
          >
            {cancelLabel}
          </button>
          {/* Destructive action: its own red, NEVER the accent; non-default. */}
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "inline-flex items-center rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 focus-visible:ring-destructive",
              FOCUS_RING,
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
