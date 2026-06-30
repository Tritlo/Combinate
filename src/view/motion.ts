/**
 * Motion preference — wraps the `prefers-reduced-motion` media query in a POSITIVE accessor:
 * `withMotion()` is true when animation is welcome, false when the user asked for reduced motion.
 * Animations (the grab/spawn pop, auto-rotate previews, …) gate on this. Resolved once (the
 * MediaQueryList is reused) since it can be polled per frame.
 */
const reducedMotionMQ = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;

/** True when motion/animation is OK (the user has NOT requested reduced motion). */
export function withMotion(): boolean {
  return !reducedMotionMQ?.matches;
}
