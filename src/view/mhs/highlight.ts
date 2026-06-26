/**
 * A tiny, dependency-free Haskell tokenizer for the panel's editor overlay. The
 * source snippets are small (a module head + a few defs), so a single-pass lexer
 * over comments / strings / chars / numbers / keywords / type-constructors is
 * plenty — no TextMate grammar needed. Colours come from GitHub's high-contrast
 * themes (light/dark), so the read-out matches GitHub's syntax palette.
 */
export type TokKind = "comment" | "string" | "number" | "keyword" | "type" | "plain";

export interface Tok {
  text: string;
  kind: TokKind;
}

const KEYWORDS = new Set([
  "module", "where", "import", "let", "in", "case", "of", "if", "then", "else",
  "do", "data", "type", "class", "instance", "newtype", "deriving", "infixl",
  "infixr", "infix", "foreign", "default", "as", "hiding", "qualified", "family",
]);

/** GitHub high-contrast token colours (`tm-themes`: github-{light,dark}-high-contrast). */
export const HL_LIGHT: Record<Exclude<TokKind, "plain">, string> = {
  comment: "#66707b",
  string: "#032563",
  number: "#023b95",
  keyword: "#a0111f",
  type: "#023b95",
};
export const HL_DARK: Record<Exclude<TokKind, "plain">, string> = {
  comment: "#bdc4cc",
  string: "#addcff",
  number: "#91cbff",
  keyword: "#ff9492",
  type: "#91cbff",
};

const isWordStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isWord = (c: string): boolean => /[A-Za-z0-9_']/.test(c);

/** Lex Haskell source into coloured tokens (adjacent uncoloured text is merged). */
export function tokenizeHaskell(src: string): Tok[] {
  const out: Tok[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) out.push({ text: plain, kind: "plain" });
    plain = "";
  };
  const push = (text: string, kind: TokKind): void => {
    flush();
    out.push({ text, kind });
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // nested block comment {- ... -} (incl. {-# pragmas #-})
    if (c === "{" && src[i + 1] === "-") {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (src[j] === "{" && src[j + 1] === "-") { depth++; j += 2; }
        else if (src[j] === "-" && src[j + 1] === "}") { depth--; j += 2; if (depth === 0) break; }
        else j++;
      }
      push(src.slice(i, j), "comment");
      i = j;
      continue;
    }
    // line comment -- ... to end of line
    if (c === "-" && src[i + 1] === "-") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      push(src.slice(i, j), "comment");
      i = j;
      continue;
    }
    // string literal "..."
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      j = Math.min(j + 1, n);
      push(src.slice(i, j), "string");
      i = j;
      continue;
    }
    // char literal '\n' / 'a' (a lone ' that isn't a prime in an identifier)
    if (c === "'") {
      const m = /^'(\\[\s\S]|[^'\\])'/.exec(src.slice(i));
      if (m) {
        push(m[0], "string");
        i += m[0].length;
        continue;
      }
    }
    // number (hex / octal / decimal, with a fractional/exponent tail)
    if (/[0-9]/.test(c)) {
      const m = /^(0[xX][0-9a-fA-F]+|0[oO][0-7]+|\d+\.?\d*([eE][+-]?\d+)?)/.exec(src.slice(i));
      const text = m ? m[0] : c;
      push(text, "number");
      i += text.length;
      continue;
    }
    // identifier / keyword / type constructor
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWord(src[j])) j++;
      const w = src.slice(i, j);
      const kind: TokKind = KEYWORDS.has(w) ? "keyword" : /^[A-Z]/.test(w) ? "type" : "plain";
      if (kind === "plain") plain += w;
      else push(w, kind);
      i = j;
      continue;
    }
    // anything else (operators, punctuation, whitespace) — accumulate as plain
    plain += c;
    i++;
  }
  flush();
  return out;
}

const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** Render Haskell source to HTML spans using the given kind→colour map. */
export function highlightHaskell(src: string, colors: Record<Exclude<TokKind, "plain">, string>): string {
  return tokenizeHaskell(src)
    .map((tok) => (tok.kind === "plain" ? esc(tok.text) : `<span style="color:${colors[tok.kind]}">${esc(tok.text)}</span>`))
    .join("");
}
