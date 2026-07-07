/**
 * Simple-type inference lens (ADR 0003): Hindley–Milner over a combinator tree.
 * It answers the conceptual question the value reader can't — *does this term
 * have a simple type, and what is it?* — and so draws the typed/untyped boundary
 * that is the heart of the calculus: `S`, `K`, `B`, `C`, `W` and friends type
 * cleanly, while self-application (`M = x x`, `L`, `U`, the fixpoint `Y`) has **no
 * simple type**. That "untypable" verdict is the lesson, not an error.
 *
 * Pure (no Pixi/DOM). The three primitives carry hard-coded schemes; every named
 * bird gets a scheme inferred once from its (SKI) definition and instantiated
 * fresh per use (so birds behave as polymorphic constants); `ι` gets the scheme
 * of its SKI form `S (S I (K S)) (K K)`. A failed unification — in particular the
 * occurs check — means no simple type.
 */
import { type Node, app, comb } from "./term";
import { normalize } from "./reduce";

type T = { k: "v"; id: number } | { k: "fn"; a: T; b: T };
const v = (id: number): T => ({ k: "v", id });
const fn = (a: T, b: T): T => ({ k: "fn", a, b });

/** A type scheme: a body over `n` generalised variables (ids `0…n-1`). */
interface Scheme {
  n: number;
  body: T;
}

class Untypable extends Error {}

/** One inference run: a fresh substitution + variable counter. */
class Ctx {
  private subst = new Map<number, T>();
  private c = 0;
  fresh(): T {
    return v(this.c++);
  }
  /** Follow the substitution one level (and through chained vars). */
  resolve(t: T): T {
    while (t.k === "v") {
      const s = this.subst.get(t.id);
      if (!s) return t;
      t = s;
    }
    return t;
  }
  private occurs(id: number, t: T): boolean {
    t = this.resolve(t);
    return t.k === "v" ? t.id === id : this.occurs(id, t.a) || this.occurs(id, t.b);
  }
  unify(x: T, y: T): void {
    x = this.resolve(x);
    y = this.resolve(y);
    if (x.k === "v") {
      if (y.k === "v" && y.id === x.id) return;
      if (this.occurs(x.id, y)) throw new Untypable("self-application"); // infinite type
      this.subst.set(x.id, y);
      return;
    }
    if (y.k === "v") return this.unify(y, x);
    this.unify(x.a, y.a);
    this.unify(x.b, y.b);
  }
  /** Instantiate a scheme with fresh variables. */
  inst(s: Scheme): T {
    const m = Array.from({ length: s.n }, () => this.fresh());
    const go = (t: T): T => (t.k === "v" ? m[t.id] : fn(go(t.a), go(t.b)));
    return go(s.body);
  }
}

// The three primitive schemes.
const PRIM: Record<string, Scheme> = {
  I: { n: 1, body: fn(v(0), v(0)) }, // a → a
  K: { n: 2, body: fn(v(0), fn(v(1), v(0))) }, // a → b → a
  S: { n: 3, body: fn(fn(v(0), fn(v(1), v(2))), fn(fn(v(0), v(1)), fn(v(0), v(2)))) }, // (a→b→c)→(a→b)→a→c
};

const schemes = new Map<string, Scheme | null>(); // null = the bird is untypable

/** Generalise a fully-resolved type into a portable scheme (free vars → 0…n-1). */
function generalize(ctx: Ctx, t: T): Scheme {
  const idx = new Map<number, number>();
  const go = (x: T): T => {
    x = ctx.resolve(x);
    if (x.k === "v") {
      if (!idx.has(x.id)) idx.set(x.id, idx.size);
      return v(idx.get(x.id)!);
    }
    return fn(go(x.a), go(x.b));
  };
  const body = go(t);
  return { n: idx.size, body };
}

/** The scheme for a named bird (or `ι`), inferred once from its definition and
 *  memoised; `null` if that definition has no simple type. */
function schemeOf(sym: string, def: () => Node): Scheme | null {
  if (schemes.has(sym)) return schemes.get(sym)!;
  let s: Scheme | null;
  try {
    const ctx = new Ctx();
    s = generalize(ctx, inferIn(ctx, def(), new Map()));
  } catch (e) {
    if (!(e instanceof Untypable)) throw e;
    s = null;
  }
  schemes.set(sym, s);
  return s;
}

// ι ≡ S (S I (K S)) (K K); its scheme is inferred from that SKI term.
const S = (): Node => comb("S");
const K = (): Node => comb("K");
const I = (): Node => comb("I");
const iotaSKI = (): Node => app(app(S(), app(app(S(), I()), app(K(), S()))), app(K(), K()));

function inferIn(ctx: Ctx, n: Node, env: Map<string, T>): T {
  switch (n.kind) {
    case "iota": {
      const s = schemeOf("ι", iotaSKI);
      if (!s) throw new Untypable("ι");
      return ctx.inst(s);
    }
    case "comb": {
      if (PRIM[n.sym]) return ctx.inst(PRIM[n.sym]);
      if (!n.def) throw new Untypable(`no def for ${n.sym}`);
      const s = schemeOf(n.sym, () => n.def!);
      if (!s) throw new Untypable(n.sym);
      return ctx.inst(s);
    }
    case "free": {
      let t = env.get(n.name);
      if (!t) env.set(n.name, (t = ctx.fresh())); // a free var is one shared monotype
      return t;
    }
    case "app": {
      const tf = inferIn(ctx, n.fn, env);
      const tx = inferIn(ctx, n.arg, env);
      const r = ctx.fresh();
      ctx.unify(tf, fn(tx, r));
      return r;
    }
  }
}

/** Pretty-print a resolved type with `a, b, c…` and right-associative `→` (only
 *  a function on the *left* of an arrow needs parentheses). */
function render(t: T): string {
  const names = new Map<number, string>();
  const name = (id: number): string => {
    if (!names.has(id)) names.set(id, String.fromCharCode(97 + names.size));
    return names.get(id)!;
  };
  const go = (x: T): string => {
    if (x.k === "v") return name(x.id);
    const left = x.a.k === "fn" ? `(${go(x.a)})` : go(x.a);
    return `${left} → ${go(x.b)}`;
  };
  return go(t);
}

/**
 * The principal simple type of a term as a string (`(a → a) → a → a`), or `null`
 * if it has no simple type (self-application / a unification clash). Inferred on
 * the *behavior* — the normal form, so `ι ι` reads as `a → a` (it is `I`),
 * matching how discovery, value-reading and refolding all work; a term with no
 * normal form (e.g. `Y`) is typed as written, which is untypable anyway.
 */
export function inferType(n: Node): string | null {
  const nf = normalize(n, 10_000, true); // fast mode — see value.ts/probe.ts (reading a named combinator must not unfold its SKI tree)
  const term = nf.done ? nf.term : n;
  try {
    const ctx = new Ctx();
    return render(generalize(ctx, inferIn(ctx, term, new Map())).body);
  } catch (e) {
    if (e instanceof Untypable) return null;
    throw e;
  }
}
