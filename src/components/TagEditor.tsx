/**
 * TagEditor — accessible chip input for a subscription's free-form tags
 * (Story 3.4, FR-3).
 *
 * Renders the current tags as removable chips plus a labelled add field. Tags
 * are free-form strings, trimmed, and de-duplicated case-insensitively per
 * subscription (order-preserving) — all via the pure `core/categories.addTag` /
 * `removeTag` helpers, so the renderer carries no tag grammar of its own.
 *
 * Commit rules (keyboard-complete):
 *   - Enter commits the current input.
 *   - A comma (typed OR pasted) commits EVERY non-empty comma-separated segment —
 *     pasting "a,b,c" adds a, b, AND c — and keeps any trailing non-comma text in
 *     the input (review finding E). A blank/whitespace segment is ignored.
 *   - Backspace on an empty input removes the last chip (a common chip-input
 *     affordance), keyboard-only, no mouse required.
 *
 * Accessibility: each chip's remove button has an accessible name
 * ("Remove tag <tag>"); the add field is labelled; the control is fully keyboard
 * operable with visible focus rings. `onChange` reports the next tag array to the
 * parent, which owns persistence (the modal patches `tags` through `subs:update`).
 */

import { useId, useState } from "react";
import { X } from "lucide-react";

import { addTag, removeTag } from "core/categories";
import { cn } from "@/lib/utils";

/** Shared focus-ring utility, consistent with the app shell (Req 22.1, 22.3). */
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export interface TagEditorProps {
  /** The current tags (controlled). */
  tags: string[];
  /** Called with the NEXT tag array whenever a tag is added or removed. */
  onChange: (tags: string[]) => void;
  /** Optional label text for the add field. Defaults to "Tags". */
  label?: string;
}

/**
 * Commit `raw` into `tags`, splitting on commas so a pasted/typed
 * comma-separated string adds EVERY non-empty segment (finding E). Returns the
 * next tag array. Empty/whitespace segments are dropped by `addTag`.
 */
function commitSegments(tags: string[], raw: string): string[] {
  return raw.split(",").reduce((acc, segment) => addTag(acc, segment), tags);
}

/** Accessible tag chip input. See the module docstring for the commit rules. */
export default function TagEditor({
  tags,
  onChange,
  label = "Tags",
}: TagEditorProps): JSX.Element {
  const inputId = useId();
  const [draft, setDraft] = useState("");

  function handleAdd(raw: string): void {
    const next = commitSegments(tags, raw);
    if (next.length !== tags.length) onChange(next);
  }

  function handleRemove(tag: string): void {
    onChange(removeTag(tags, tag));
  }

  function handleChange(value: string): void {
    // A comma (typed or part of a paste) commits every completed segment and
    // keeps the trailing non-comma remainder in the input.
    if (value.includes(",")) {
      const lastComma = value.lastIndexOf(",");
      const toCommit = value.slice(0, lastComma); // everything up to the last comma
      const remainder = value.slice(lastComma + 1); // trailing text after it
      handleAdd(toCommit);
      setDraft(remainder);
      return;
    }
    setDraft(value);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      handleAdd(draft);
      setDraft("");
      return;
    }
    // Escape within the tag field must NOT bubble to the host modal (which would
    // close it and discard edits); swallow it here (no tag behavior change).
    if (event.key === "Escape") {
      event.stopPropagation();
      return;
    }
    // Backspace on an empty input removes the last chip (keyboard affordance).
    if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      event.preventDefault();
      handleRemove(tags[tags.length - 1]);
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Current tags">
          {tags.map((tag) => (
            <li key={tag}>
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-sm text-foreground">
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => handleRemove(tag)}
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:text-foreground",
                    FOCUS_RING,
                  )}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <input
        id={inputId}
        type="text"
        value={draft}
        placeholder="Add a tag and press Enter"
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          // Commit a pending draft on blur so a typed-but-not-entered tag is not lost.
          if (draft.trim() !== "") {
            handleAdd(draft);
            setDraft("");
          }
        }}
        className={cn(
          "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground",
          FOCUS_RING,
        )}
      />
    </div>
  );
}
