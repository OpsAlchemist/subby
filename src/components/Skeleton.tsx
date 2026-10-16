/**
 * Cold-load skeleton placeholder (Story 6.1).
 *
 * A tokenized shimmer block shown while the Dashboard's data (and the FX
 * snapshot) are still loading — a calm placeholder, NOT a spinner. It is purely
 * decorative: `aria-hidden` so assistive tech skips the shimmering boxes, and
 * the gentle pulse is suppressed under `prefers-reduced-motion`
 * (`motion-reduce:animate-none`). The surrounding view owns the single live
 * "loading" announcement; this block itself announces nothing.
 */

export interface SkeletonProps {
  /** Optional class applied after the base placeholder styles (e.g. sizing). */
  className?: string;
}

/**
 * A single muted, rounded placeholder block. Decorative only (`aria-hidden`);
 * pass sizing via `className`.
 */
export default function Skeleton({ className }: SkeletonProps): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-muted motion-reduce:animate-none${
        className ? ` ${className}` : ""
      }`}
    />
  );
}
