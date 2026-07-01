/**
 * A parser for the SKI-Quest expression language → Combinate's pure {@link Node}
 * model. The Quest puzzles (adapted, with permission, from Konstantin S. Uvarin's
 * SKI Quest) state goals as little SKI expressions; this turns those strings into
 * terms our reducer can run.
 *
 * Grammar (left-associative application by juxtaposition):
 *   program := (ident '=' expr ';')*  expr        — optional local definitions
 *   expr    := ident '->' expr  |  atom+          — λ (right-assoc) or application
 *   atom    := '(' expr ')' | comb | ident | num
 *
 * Tokenisation follows the SKI Quest's own rules: an UPPER-case letter is a
 * single-character combinator (so `KI` is `K I`, `BC(CI)` is `B C (C I)`), a
 * lower-case run is one identifier (`phi`, `nil`, `is_empty`; `zSK` is `z S K`),
 * digits are a Church numeral, `->` is lambda, `+`/`*` are markers (free vars).
 *
 * Resolution of a bare identifier, in order: a λ-bound parameter, then the
 * supplied `scope` (local defs, env, the term(s) you are building), then a catalog
 * combinator, otherwise a free variable. Lambdas compile to SKI by the standard
 * bracket abstraction, so the whole language lands in ι/S/K/app/free.
 */
import { type Node, app, comb, cloneTerm, freeVar, freshId } from "../term";
import { CATALOG, named } from "../catalog";
import { kernelArity } from "../kernels";
import { bracket, church } from "../church";

const COMB_SYMS = new Set(CATALOG.map((l) => l.sym));

// ---- tokeniser ----
type Tok = { t: "(" | ")" | "->" | "=" | ";" | "comb" | "id" | "num"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c === "(" || c === ")" || c === "=" || c === ";") { out.push({ t: c as Tok["t"], v: c }); i++; continue; }
    if (c === "-" && src[i + 1] === ">") { out.push({ t: "->", v: "->" }); i += 2; continue; }
    if (c >= "0" && c <= "9") { let j = i; while (j < src.length && src[j] >= "0" && src[j] <= "9") j++; out.push({ t: "num", v: src.slice(i, j) }); i = j; continue; }
    if (c >= "A" && c <= "Z") { out.push({ t: "comb", v: c }); i++; continue; }
    if (c === "+" || c === "*") { out.push({ t: "id", v: c }); i++; continue; } // successor / mult markers → free vars
    if ((c >= "a" && c <= "z") || c === "_") { let j = i; while (j < src.length && /[a-z0-9_]/.test(src[j])) j++; out.push({ t: "id", v: src.slice(i, j) }); i = j; continue; }
    throw new Error(`SKIQ parse: unexpected '${c}' in "${src}"`);
  }
  return out;
}

// ---- AST ----
type Ast =
  | { k: "lam"; p: string; b: Ast }
  | { k: "app"; f: Ast; a: Ast }
  | { k: "comb"; v: string }
  | { k: "id"; v: string }
  | { k: "num"; v: number };

class P {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}
  private peek(o = 0): Tok | undefined { return this.toks[this.i + o]; }
  private eat(t?: Tok["t"]): Tok {
    const tok = this.toks[this.i++];
    if (!tok || (t && tok.t !== t)) throw new Error(`SKIQ parse: expected ${t}, got ${tok?.t ?? "EOF"}`);
    return tok;
  }
  atEnd(): boolean { return this.i >= this.toks.length; }

  expr(): Ast {
    if (this.peek()?.t === "id" && this.peek(1)?.t === "->") {
      const p = this.eat("id").v;
      this.eat("->");
      return { k: "lam", p, b: this.expr() };
    }
    let e = this.atom();
    while (this.startsAtom()) e = { k: "app", f: e, a: this.atom() };
    return e;
  }
  private startsAtom(): boolean {
    const t = this.peek()?.t;
    return t === "(" || t === "comb" || t === "id" || t === "num";
  }
  private atom(): Ast {
    const tok = this.peek();
    if (tok?.t === "(") { this.eat("("); const e = this.expr(); this.eat(")"); return e; }
    if (tok?.t === "comb") { this.eat(); return { k: "comb", v: tok.v }; }
    if (tok?.t === "id") { this.eat(); return { k: "id", v: tok.v }; }
    if (tok?.t === "num") { this.eat(); return { k: "num", v: Number(tok.v) }; }
    throw new Error(`SKIQ parse: expected atom, got ${tok?.t ?? "EOF"}`);
  }
}

/** Clone a term, moving its free variables into a reserved namespace — so the
 *  term you are *building* (which may itself mention a free `x`) can't be confused
 *  with a case's argument `x`. SKI Quest treats `K x` as NOT the identity for
 *  exactly this reason; in Combinate built sources have no free vars, so this is a
 *  no-op there and only sharpens the engine's faithfulness. */
export function freezeFree(n: Node): Node {
  switch (n.kind) {
    case "iota": return { ...n, id: freshId() };
    case "comb": return { ...n, id: freshId(), def: n.def ? freezeFree(n.def) : undefined };
    case "free": return freeVar(`§own§${n.name}`);
    case "app": return app(freezeFree(n.fn), freezeFree(n.arg));
  }
}


/** A resolver for free identifiers: returns a (freshly-cloned) term to splice in,
 *  or null to fall through to "catalog combinator, else free variable". */
export type Scope = (name: string) => Node | null;

function compile(ast: Ast, scope: Scope, bound: Set<string>): Node {
  switch (ast.k) {
    case "num": return church(ast.v);
    case "app": return app(compile(ast.f, scope, bound), compile(ast.a, scope, bound));
    case "lam": {
      const inner = new Set(bound).add(ast.p);
      return bracket(ast.p, compile(ast.b, scope, inner));
    }
    // a bare name (lower- or upper-case): a λ-bound param, then the scope (local
    // defs, env, the term you're building — these SHADOW a same-letter combinator,
    // e.g. input `Z` or env `M=WI`), then a catalog combinator, else a free var.
    case "comb":
    case "id": {
      if (bound.has(ast.v)) return freeVar(ast.v);
      const got = scope(ast.v);
      if (got) return cloneTerm(got);
      if (COMB_SYMS.has(ast.v)) return named(ast.v);
      const ka = kernelArity(ast.v); // a kernel-only primitive (e.g. Church `cmod`, ADR 11)
      if (ka !== undefined) return comb(ast.v, undefined, ka);
      return freeVar(ast.v);
    }
  }
}

/**
 * Parse one expression string (optionally prefixed with `name = expr;` local
 * definitions, which are added to the scope left-to-right) to a {@link Node}.
 */
export function parseExpr(src: string, scope: Scope): Node {
  const segments = src.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
  const locals = new Map<string, Node>();
  const chained: Scope = (name) => locals.get(name) ?? scope(name);
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const toks = tokenize(seg);
    const eq = toks.findIndex((t) => t.t === "=");
    if (eq === 1 && (toks[0].t === "id" || toks[0].t === "comb")) {
      const name = toks[0].v;
      const node = compileToks(toks.slice(eq + 1), chained);
      locals.set(name, node);
    } else {
      return compileToks(toks, chained); // the final, definition-free segment
    }
  }
  throw new Error(`SKIQ parse: no expression in "${src}"`);
}

function compileToks(toks: Tok[], scope: Scope): Node {
  const p = new P(toks);
  const ast = p.expr();
  if (!p.atEnd()) throw new Error("SKIQ parse: trailing tokens");
  return compile(ast, scope, new Set());
}
