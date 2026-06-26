# MicroHs fork changes for the in-browser compiler (ADR 0007, PLAN.md Phase 0)

The vendored WASM slice is built from a fork of MicroHs (`../MicroHs`) with the
three changes below. They are small relative to the compiler and change rarely
(the slice is pinned to a MicroHs version + `base.pkg`).

## 1. A thin `compileToComb` entry point

Combinate needs `Haskell source → combinator dump` as one call. MicroHs already
factors the stages — reuse them:

- `compileInteractive` / `Interactive.compile` (parse → typecheck → desugar) and
  the **pure** `compileToCombinators :: TModule [LDef] -> TModule [LDef]`
  (`src/MicroHs/Compile.hs`).
- Add `compileToComb :: String -> IO String` that runs that pipeline against the
  loaded `base` symbol tables and returns the `-ddump-combinator` text (the same
  parenthesised-prefix dump the `iota/` tools already parse).
- Export it for the emscripten entry (a `_compileToComb` C export / JS binding).

## 2. Char literals → Scott `Nat` of the ASCII code

`Char` is not class-overloaded like numeric literals, so the desugaring of char
literals must be redirected in the fork:

- Where the desugarer lowers a `Char` literal (the `Lit (LChar c)` path in the
  desugar/`Exp` stage), emit `fromInteger (ord c)` against the primitive-free
  Prelude's `Nat` instead of a primitive `Char`/`Word`.
- Result: `'A' :: Nat` (= 65 as Scott `Nat`), `String = [Nat]` — text becomes pure ι.

## 3. A primitive-free Prelude

Ship an alternative Prelude (selected for the slice; the curated examples and the
free-type panel import it) where:

- `Nat` is the Scott Peano type (`data Nat = Z | S Nat`), with `Num`/`Ord`
  instances so `fromInteger`, `+`, `*`, `-` (monus), `==`, `<=` are the Scott
  versions — numeric literals become Scott `Nat`.
- `Char`/`String` are `Nat`/`[Nat]` (see change 2).
- Lists/`Bool`/tuples use the standard Scott encoding (already what MicroHs emits).
- `IO`, FFI, `Float`, machine `Int`/`Word` are **absent** — a program that needs
  them fails to compile against this Prelude, which is the honest reject.

## Build

The `mhs-wasm` make target (referenced by `nix/build-mhs-wasm.sh`) trims the
emscripten/web build to the compiler (drop the REPL/FFI), links the above, and
emits the compile-only slice + `base.pkg`. Char/string programs produce enormous
ι-trees (a char ≈ 65 nested `Succ`); the app's **optimize mode** (v5) recovers
usability, exactly as for `2*2`.
