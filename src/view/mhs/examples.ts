/**
 * Curated, primitive-free Haskell examples for the in-browser compiler panel
 * (ADR 0007). Each compiles to pure ι via the post-processor (`core/mhs.ts`) and
 * reduces in the sandbox. They lead the panel so the first experience is "watch
 * *this* real Haskell become birds and run" — free-typing is the power feature.
 *
 * Chosen to reduce feasibly under the no-sharing tree reducer: linear/structural
 * programs (`map`, `reverse`, `filter`, folds, comparisons). Multiplication-heavy
 * recursion (`fac n` for n ≥ 4) blows up exponentially without graph sharing, so
 * `fac` is capped at 3 and labelled.
 */
import type { Ty } from "../../core/types";

export interface Example {
  /** Asset id — the pruned dump is vendored at `mhs/examples/<name>.comb`. */
  name: string;
  /** Panel label. */
  title: string;
  /** One line on what it demonstrates. */
  blurb: string;
  /** The Haskell source, shown in the panel and compiled by `gmhs` at build time. */
  source: string;
  /** The top-level def to spawn and reduce. */
  root: string;
  /** The read-out lens for the result. */
  read: Ty;
  /** If `root` is a function, the Scott numeral to apply (generator sanity-check only). */
  arg?: number;
}

const mod = (body: string): string => `module Ex(out) where\n${body}\n`;

export const EXAMPLES: Example[] = [
  {
    name: "arith",
    title: "arithmetic",
    blurb: "2 * 3 + 4 — numbers are Scott Peano naturals; × is repeated addition.",
    source: mod("out :: Int\nout = 2 * 3 + 4"),
    root: "Ex.out",
    read: "Int",
  },
  {
    name: "inc",
    title: "map over a list",
    blurb: "map (+1) over a list — every (:) is the cons combinator, [] is the Kestrel.",
    source: mod("out :: [Int]\nout = map (\\x -> x + 1) [1, 2, 3]"),
    root: "Ex.out",
    read: "List",
  },
  {
    name: "sum",
    title: "fold a list",
    blurb: "foldr (+) 0 — the classic fold, recursion threaded through the Sage Y.",
    source: mod("out :: Int\nout = foldr (+) 0 [1, 2, 3, 4, 5]"),
    root: "Ex.out",
    read: "Int",
  },
  {
    name: "filter",
    title: "filter a list",
    blurb: "keep the elements below 3 — a comparison returning a Scott Boolean.",
    source: mod("out :: [Int]\nout = filter (\\x -> x < 3) [1, 2, 3, 4]"),
    root: "Ex.out",
    read: "List",
  },
  {
    name: "rev",
    title: "reverse a string",
    blurb: "reverse \"abc\" — a String is [Char], each Char its ASCII Scott numeral.",
    source: mod('out :: String\nout = reverse "abc"'),
    root: "Ex.out",
    read: "Char",
  },
  {
    name: "fac",
    title: "factorial (3)",
    blurb: "fac 3 = 6 — recursion + ×. Watch it churn: without sharing, × recomputes.",
    source: mod("fac :: Int -> Int\nfac n = if n <= 1 then 1 else n * fac (n - 1)\nout :: Int\nout = fac 3"),
    root: "Ex.out",
    read: "Int",
  },
  {
    name: "lt",
    title: "2 < 3",
    blurb: "a comparison on Scott naturals, reading back the Scott Boolean True.",
    source: mod("out :: Bool\nout = (2 :: Int) < 3"),
    root: "Ex.out",
    read: "Bool",
  },
  {
    name: "quicksort",
    title: "quicksort",
    blurb: "quicksort [3,1,2] — partition by a pivot with filter, recurse, ++ the parts. A meaty tree.",
    source: mod("qs :: [Int] -> [Int]\nqs [] = []\nqs (p:xs) = qs (filter (< p) xs) ++ (p : qs (filter (>= p) xs))\nout :: [Int]\nout = qs [3, 1, 2]"),
    root: "Ex.out",
    read: "List",
  },
];
