/**
 * Authoring (ADR 0006): the player verb for *building* your own combinators
 * rather than only discovering them — **Define** (name a tree you built). This
 * module is the pure core of it: leaf/subtree surgery, name validation, and
 * registering a user combinator into the shared catalog. The UI gesture +
 * persistence live in the shell.
 *
 * A user-defined combinator is the *same object as a discovery* (CONTEXT.md): a
 * named leaf backed by a tree. So `defineCombinator` appends an ordinary `Law` to
 * the catalog (flagged `userDefined` so the probe never auto-matches it) and a
 * slot to a dedicated "Custom" page — the rest of the app (hotbar, Zoo, reducer,
 * read-out) then treats it like any other bird.
 */
import { type Node, type NodeId, app, comb, freeVar, iota } from "./term";
import { CATALOG, PAGES, RULES, lam, type Law, type PageDef } from "./catalog";

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


// ---- the namespace of user-defined combinators ----

/** The hotbar/Zoo page holding user-authored combinators. Pushed onto the shared
 *  `PAGES` at load (so the Zoo snapshots it) and grown in place as the player
 *  Defines new blocks. */
const CUSTOM_PAGE: PageDef = { name: "Custom", entries: [] };
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
 * its body as soon as it is applied. The probe skips `userDefined` laws (it is
 * authored, not discovered).
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

// ---- "Add Rule": author a combinator from a rewrite rule `name args = body` ----

/** A successfully parsed rewrite rule: the LHS name and binders, a builder that
 *  produces the RHS body from the actual argument terms (`v[i]` for the i-th
 *  binder), and the trimmed source text (reused verbatim as the law's display). */
export interface ParsedRule {
  name: string;
  args: string[];
  body: (v: Node[]) => Node;
  lawText: string;
}

/** A v1 rule identifier: an ASCII letter then word characters (ι is handled
 *  separately as a leaf). Operator-symbol birds like `(+)`/`<>` are out of scope. */
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Parse a player's rewrite rule `name args = body` into a {@link ParsedRule}, or
 * `{ error }` with a player-facing message. The LHS (left of the first `=`) is
 * whitespace-split into the combinator name and its argument binders; the RHS is
 * tokenized (identifiers + parens) and parsed as **left-associative application**
 * with parens for grouping. Each RHS leaf maps to a builder: a binder → that
 * argument (`v[i]`, binders shadowing catalog symbols), a catalog combinator →
 * its collapsed named node, `ι` → a fresh iota; anything else is an error. The
 * name must pass {@link validateName} and the binders must be distinct identifiers.
 */
export function parseRule(input: string): ParsedRule | { error: string } {
  const eq = input.indexOf("=");
  if (eq < 0) return { error: "rule needs an '=' (e.g. W f x = f x x)" };
  const lhs = input.slice(0, eq).trim();
  const rhs = input.slice(eq + 1).trim();

  const lhsParts = lhs.split(/\s+/).filter(Boolean);
  const name = lhsParts[0];
  if (!name) return { error: "missing combinator name (left of '=')" };
  const nameErr = validateName(name);
  if (nameErr) return { error: nameErr };

  const args = lhsParts.slice(1);
  for (const a of args) {
    if (!IDENT.test(a)) return { error: `invalid argument name: ${a}` };
  }
  if (new Set(args).size !== args.length) return { error: "arguments must be distinct" };

  if (!rhs) return { error: "missing rule body (right of '=')" };

  // A leaf resolves to a builder once, at parse time: a binder shadows everything,
  // then ι, then a catalog combinator (rebuilt fresh each application so ids stay
  // unique), else it's an unknown symbol.
  const leaf = (t: string): ((v: Node[]) => Node) => {
    const ai = args.indexOf(t);
    if (ai >= 0) return (v) => v[ai];
    if (t === "ι") return () => iota();
    const law = CATALOG.find((l) => l.sym === t);
    if (law) return () => comb(law.sym, law.def?.(), law.arity);
    throw new Error(`unknown symbol: ${t}`);
  };

  const toks = rhs.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // expr := atom+   (left-associative application); atom := ident | '(' expr ')'
  const parseAtom = (): ((v: Node[]) => Node) => {
    const t = toks[i];
    if (t === undefined) throw new Error("unexpected end of rule body");
    if (t === ")") throw new Error("unexpected ')'");
    if (t === "(") {
      i++;
      const e = parseExpr();
      if (toks[i] !== ")") throw new Error("missing ')'");
      i++;
      return e;
    }
    i++;
    return leaf(t);
  };
  const parseExpr = (): ((v: Node[]) => Node) => {
    let left = parseAtom();
    while (i < toks.length && toks[i] !== ")") {
      const right = parseAtom();
      const f = left;
      left = (v) => app(f(v), right(v));
    }
    return left;
  };

  try {
    const body = parseExpr();
    if (i < toks.length) throw new Error(`unexpected '${toks[i]}'`);
    return { name, args, body, lawText: input.trim() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Register a player-authored combinator from a parsed rewrite rule: append an
 * ordinary {@link Law} to the catalog and a slot to the Custom page, and install
 * its `rule` into the live {@link RULES} table so Rule-based reduction fires it in
 * ONE step when saturated (`name a b … ⇒ body`). `def` is the bracket-abstracted
 * ι/SKI fallback used when the optimization is off. The probe skips it
 * (`userDefined`). Caller should {@link parseRule} (which validates) first.
 */
export function defineRule(name: string, args: string[], body: (v: Node[]) => Node, lawText: string): Law {
  const law: Law = {
    sym: name,
    lawText,
    arity: args.length,
    reference: body, // unused for userDefined (the probe skips them), set for parity with bird()
    rule: body,
    def: () => lam(args.length, body),
    userDefined: true,
  };
  CATALOG.push(law);
  RULES[name] = body; // RULES is a load-time snapshot; runtime laws must opt in so `fast` reduction sees them
  CUSTOM_PAGE.entries.push({ sym: name });
  return law;
}
