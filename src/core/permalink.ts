/**
 * Permalink codec (PLAN.md Phase A): a tree + the active display modes packed into
 * a compact, URL-safe token — the unit of sharing (CONTEXT.md). A solution / a
 * leaderboard entry / a saved sandbox *is* a permalink.
 *
 * Pure (no Pixi/DOM): the tree is serialised with the existing `toEgg`/`fromEgg`
 * boundary (which round-trips named combinators, free vars, and ι exactly — not
 * just pure-ι bit-code), then base64url-wrapped with a version tag so old links
 * keep working across releases.
 */
import { type Node } from "./term";
import { toEgg, fromEgg } from "./refold";

/** The toggleable readings/modes carried alongside a shared tree. */
export interface Modes {
  optimize?: boolean; // named-combinator reduction (v5 optimize toggle)
  graph?: boolean; // graph-reduction sharing (the "graph" toggle — NOT the permalink "share")
  refold?: boolean; // legacy (≤c1): the egg refold lens — decoded as view "named"
  view?: "ski" | "named" | "barker"; // read-out view (default "ski"); see ReadoutBox
  type?: boolean; // the HM type lens
  expand?: boolean; // draw every combinator as its full ι-tree
  page?: string; // the active hotbar page (Programs/Booleans/…)
  transport?: "play" | "pause" | "ff"; // playback speed
}

const VERSION = "c1";

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(t: string): string {
  const bin = atob(t.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode a tree + active modes into a versioned, URL-safe permalink token. */
export function encodePermalink(tree: Node, modes: Modes = {}): string {
  return VERSION + b64urlEncode(JSON.stringify({ t: toEgg(tree), m: modes }));
}

/** Decode a permalink token back to a tree + modes, or null if malformed / a
 *  version we don't understand. */
export function decodePermalink(token: string): { tree: Node; modes: Modes } | null {
  if (!token.startsWith(VERSION)) return null;
  try {
    const { t, m } = JSON.parse(b64urlDecode(token.slice(VERSION.length))) as { t: string; m?: Modes };
    return { tree: fromEgg(t), modes: m ?? {} };
  } catch {
    return null;
  }
}
