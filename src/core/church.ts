/**
 * Church numerals + bracket abstraction (ADR 11) — reducer-free, so the SKI-Quest parser,
 * the engine, and the Church kernels all share it without an import cycle (this module
 * imports only `term`). `bracket` is the standard λ→SKI compiler; `church`
 * builds `λf x. fⁿ x`; `matchChurch` reads one back by applying to two fresh markers and
 * counting — with the reducer injected, so a Church kernel can match its operands using a
 * kernel-free normalize and never re-enter itself.
 */
import { type Node, app, comb, freeVar } from "./term";

// ---- bracket abstraction: λname.body → SKI (standard algorithm + η) ----
const S = (): Node => comb("S");
const K = (): Node => comb("K");
const I = (): Node => comb("I");

function occurs(name: string, n: Node): boolean {
  switch (n.kind) {
    case "free":
      return n.name === name;
    case "app":
      return occurs(name, n.fn) || occurs(name, n.arg);
    default:
      return false;
  }
}

/** Compile `λname. t` to a closed SKI term (the SKI-Quest language's lambda). */
export function bracket(name: string, t: Node): Node {
  if (t.kind === "free" && t.name === name) return I();
  if (!occurs(name, t)) return app(K(), t);
  const a = t as Extract<Node, { kind: "app" }>;
  if (a.arg.kind === "free" && a.arg.name === name && !occurs(name, a.fn)) return a.fn; // η
  return app(app(S(), bracket(name, a.fn)), bracket(name, a.arg));
}

/** The Church numeral `n` = `λf x. fⁿ x`, as a closed SKI term. */
export function church(n: number): Node {
  let body: Node = freeVar("x");
  for (let i = 0; i < n; i++) body = app(freeVar("f"), body);
  return bracket("f", bracket("x", body));
}

/** Result shape of the injected normalize (a subset of `reduce.NormalizeResult`). */
export type Normalized = { term: Node; done: boolean };

/**
 * Read a Church numeral from `node`: apply to fresh markers `§cf`/`§cx`, normalize, and
 * count the `§cf`s. Returns the count, or null if it doesn't settle to `§cfⁿ §cx`.
 * `normalize` is injected (pass a kernel-free reducer so a Church kernel can't re-enter).
 */
export function matchChurch(node: Node, normalize: (n: Node, cap: number) => Normalized, cap: number): number | null {
  const { term, done } = normalize(app(app(node, freeVar("§cf")), freeVar("§cx")), cap);
  if (!done) return null;
  let t = term;
  let k = 0;
  while (t.kind === "app" && t.fn.kind === "free" && t.fn.name === "§cf") {
    k++;
    t = t.arg;
  }
  return t.kind === "free" && t.name === "§cx" ? k : null;
}
