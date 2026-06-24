import { type Ticker } from "pixi.js";

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Drive `onUpdate(progress)` from 0→1 over `ms` on the Pixi ticker (eased), then
 * call `onDone`. Returns a cancel function. Used for HUD flourishes (toast fade,
 * hotbar slot pop).
 */
export function tween(
  ticker: Ticker,
  ms: number,
  onUpdate: (eased: number) => void,
  onDone?: () => void,
): () => void {
  let elapsed = 0;
  const cb = (tk: Ticker): void => {
    elapsed += tk.deltaMS;
    const t = Math.min(1, elapsed / ms);
    onUpdate(easeOut(t));
    if (t >= 1) {
      ticker.remove(cb);
      onDone?.();
    }
  };
  ticker.add(cb);
  return () => ticker.remove(cb);
}
