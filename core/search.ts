/**
 * Fuzzy Search (Req 12).
 *
 * Platform-independent. MUST NOT import from `electron`, `react`, or Node's `fs`.
 *
 * A lightweight subsequence + scoring matcher over a subscription's `name`
 * and `provider`. There is no external service or dependency.
 *
 * - Empty query returns all subscriptions unchanged (Req 12.3).
 * - A query matches when it is a case-insensitive subsequence of a candidate,
 *   so "net" matches "Netflix", "Internet", and "Network" (Req 12.2).
 * - Results are filtered to positive scores and sorted by score descending,
 *   so closer/contiguous matches rank higher (Req 12.1).
 */

import type { Subscription } from "./models/subscription";

/**
 * Return subscriptions whose `name` or `provider` approximately matches
 * `query`, ordered by match quality (best first).
 *
 * An empty or whitespace-only query returns all subscriptions unchanged
 * (Req 12.3).
 */
export function fuzzySearch(
  subs: Subscription[],
  query: string,
): Subscription[] {
  const q = query.trim().toLowerCase();
  if (q === "") return subs; // Req 12.3

  return subs
    .map((s) => ({ s, score: bestScore(q, [s.name, s.provider]) }))
    .filter((r) => r.score > 0) // Req 12.1
    .sort((a, b) => b.score - a.score)
    .map((r) => r.s);
}

/**
 * Return the best subsequence score of `query` across the given `candidates`.
 *
 * The score is `> 0` when `query` is a case-insensitive subsequence of at
 * least one candidate (Req 12.2), and `0` when no candidate contains the
 * subsequence. Higher scores indicate closer/more contiguous matches:
 * contiguous runs of matched characters are rewarded, gaps are penalized, and
 * matches at the start of the candidate receive a small bonus.
 */
export function bestScore(query: string, candidates: string[]): number {
  const q = query.trim().toLowerCase();
  if (q === "") return 0;

  let best = 0;
  for (const candidate of candidates) {
    const score = subsequenceScore(q, (candidate ?? "").toLowerCase());
    if (score > best) best = score;
  }
  return best;
}

/**
 * Score `query` as a subsequence of `text`. Both are assumed lowercased.
 *
 * Returns 0 when `query` is not a subsequence of `text`. Otherwise returns a
 * positive score that rewards contiguous matches and earlier matches.
 */
function subsequenceScore(query: string, text: string): number {
  if (query === "") return 0;
  if (text === "") return 0;

  let qi = 0;
  let score = 0;
  let firstMatchIndex = -1;
  let prevMatchIndex = -1;

  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) {
      if (firstMatchIndex === -1) firstMatchIndex = ti;

      // Base point for each matched character.
      score += 1;

      // Reward contiguous matches (adjacent to the previous matched char).
      if (prevMatchIndex !== -1 && ti === prevMatchIndex + 1) {
        score += 2;
      }

      prevMatchIndex = ti;
      qi++;
    }
  }

  // Not a full subsequence of this candidate.
  if (qi < query.length) return 0;

  // Small bonus for matching at the very start of the candidate.
  if (firstMatchIndex === 0) score += 1;

  // Slight penalty the later the match begins, without ever reaching zero.
  if (firstMatchIndex > 0) {
    score += 1 / (firstMatchIndex + 1);
  }

  return score;
}
