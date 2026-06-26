/**
 * Authoring (ADR 0006): the two player verbs for *building* your own combinators
 * rather than only discovering them — **Define** (name a tree you built) and
 * one-hole **Abstract** (pull a single leaf out as a hole and bracket-abstract
 * the tree over it). This module is the pure core of both: bracket abstraction,
 * leaf/subtree surgery, name validation, and registering a user combinator into
 * the shared catalog. The UI gesture + persistence live in the shell.
 *
 * A user-defined combinator is the *same object as a discovery* (CONTEXT.md): a
 * named leaf backed by a tree. So `defineCombinator` appends an ordinary `Law` to
 * the catalog (flagged `userDefined` so the probe never auto-matches it) and a
 * slot to a dedicated "Custom" page — the rest of the app (hotbar, Zoo, reducer,
 * read-out) then treats it like any other bird.
 */
import { type Node, type NodeId, app, comb, freeVar, iota } from "./term";
import { CATALOG, PAGES, type Law, type PageDef } from "./catalog";

/** The placeholder free variable a one-hole `Abstract` abstracts over. */
export const HOLE = "_";

/** Deep-copy a term with fresh ids, so each spawn of a user combinator's def
 *  gets distinct nodes (the view keys layout/animation by id). */
function clone(n: Node): Node {
  switch (n.kind) {
    case "iota":
      return iota();
    case "comb":
      return comb(n.sym, n.def ? clone(n.def) : undefined, n.arity);
    case "free":
      return freeVar(n.name);
    case "app":
      return app(clone(n.fn), clone(n.arg));
  }
}

/** Does the free variable `name` occur anywhere in `t`? */
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

/**
 * Bracket abstraction `[name] t`: the closed S/K/I term that, applied to a value
 * for `name`, reproduces `t` (so `([name]t) name = t`). The classic algorithm
 * with the η optimization — the same one `catalog.ts` uses to derive each bird's
 * `def` from its law:
 *
 * ```
 * [x] x        = I
 * [x] M        = K M            (x ∉ M)
 * [x] (M x)    = M             (η, x ∉ M)
 * [x] (M N)    = S [x]M [x]N
 * ```
 */
export function bracketAbstract(name: string, t: Node): Node {
  const S = (): Node => comb("S");
  const K = (): Node => comb("K");
  const I = (): Node => comb("I");
  if (t.kind === "free" && t.name === name) return I();
  if (!occurs(name, t)) return app(K(), t);
  const a = t as Extract<Node, { kind: "app" }>;
  if (a.arg.kind === "free" && a.arg.name === name && !occurs(name, a.fn)) return a.fn; // η
  return app(app(S(), bracketAbstract(name, a.fn)), bracketAbstract(name, a.arg));
}

/** The subtree rooted at `id` within `root`, or null if there is no such node. */
export function findSubtree(root: Node, id: NodeId): Node | null {
  if (root.id === id) return root;
  if (root.kind === "app") return findSubtree(root.fn, id) ?? findSubtree(root.arg, id);
  return null;
}

/** Replace the subtree rooted at `id` with `repl`, returning the new tree. */
export function replaceSubtree(root: Node, id: NodeId, repl: Node): Node {
  if (root.id === id) return repl;
  if (root.kind === "app") return { ...root, fn: replaceSubtree(root.fn, id, repl), arg: replaceSubtree(root.arg, id, repl) };
  return root;
}

/**
 * one-hole **Abstract**: mark the *leaf* `id` as a hole and bracket-abstract the
 * whole tree over it, yielding a new combinator's body (a closed S/K/I term such
 * that `body hole = tree`). Returns null if `id` is an application node rather
 * than a leaf (only ONE leaf may be the hole — no multi-hole / lambda editor).
 */
export function abstractLeaf(tree: Node, id: NodeId): Node | null {
  let marked = false;
  const go = (n: Node): Node => {
    if (n.id === id) {
      if (n.kind === "app") return n; // not a leaf — leave it; `marked` stays false
      marked = true;
      return freeVar(HOLE);
    }
    if (n.kind === "app") return { ...n, fn: go(n.fn), arg: go(n.arg) };
    return n;
  };
  const holed = go(tree);
  if (!marked) return null;
  return bracketAbstract(HOLE, holed);
}

// ---- the namespace of user-defined combinators ----

/** The hotbar/Zoo page holding user-authored combinators. Pushed onto the shared
 *  `PAGES` at load (so the Zoo snapshots it) and grown in place as the player
 *  Defines new blocks. */
export const CUSTOM_PAGE: PageDef = { name: "Custom", entries: [] };
PAGES.push(CUSTOM_PAGE);

/** Is `name` already a catalog symbol (a built-in bird or a prior user comb)? */
export function isNameTaken(name: string): boolean {
  return name === "ι" || CATALOG.some((l) => l.sym === name);
}

/**
 * Validate a proposed combinator name. Returns an error message to show the
 * player, or null when the name is acceptable. Names must be non-empty, short,
 * free of characters that would break the s-expression wire format, and must not
 * collide with an existing combinator (ADR 0006: reject duplicates).
 */
export function validateName(name: string): string | null {
  const n = name.trim();
  if (!n) return "name cannot be empty";
  if (n.length > 12) return "name too long (max 12)";
  if (/[\s()@]/.test(n)) return "name cannot contain spaces, parens or @";
  if (isNameTaken(n)) return `"${n}" is already taken`;
  return null;
}

/**
 * Register a user-defined combinator from its name and body tree: append it to
 * the catalog (so the whole app treats it like any other bird) and to the Custom
 * page (so it appears in the hotbar/Zoo). `arity` is 1 — a Defined block unfolds
 * its body as soon as it is applied, and a one-hole Abstract takes exactly one
 * argument. The probe skips `userDefined` laws (it is authored, not discovered).
 * Returns the new `Law`. Caller should `validateName` first.
 */
export function defineCombinator(name: string, def: Node): Law {
  const law: Law = {
    sym: name,
    lawText: `${name} — authored`,
    arity: 1,
    reference: () => freeVar(`$user_${name}`), // never used (probe skips userDefined)
    def: () => clone(def),
    userDefined: true,
  };
  CATALOG.push(law);
  CUSTOM_PAGE.entries.push({ sym: name });
  return law;
}
