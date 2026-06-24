import { type Node, app } from "./term";

/**
 * A discoverable combinator law (§7.2). Data only — the probe (probe.ts) tests a
 * term against it behaviourally, and the shell turns a match into a toast +
 * hotbar slot.
 */
export interface Law {
  /** Combinator symbol, e.g. "I", "K". */
  sym: string;
  /** Display text, reused verbatim in the toast and notebook. */
  lawText: string;
  /** Number of fresh free variables to apply when probing. */
  arity: number;
  /** Reference normal form, built from those free variables. */
  reference: (vars: Node[]) => Node;
  /** Canonical ι-tree (Barker bit-code, §4) that the hotbar slot stamps (§7.3). */
  iotaCode: string;
}

/**
 * The ι-cycle (§4): the built-in tech tree you walk by stacking ι. Each member's
 * canonical ι-tree just prepends one more ι (`01` in bit-code).
 */
export const CATALOG: Law[] = [
  { sym: "I", lawText: "I x = x", arity: 1, reference: (v) => v[0], iotaCode: "011" },
  { sym: "A", lawText: "A x y = y", arity: 2, reference: (v) => v[1], iotaCode: "01011" },
  { sym: "K", lawText: "K x y = x", arity: 2, reference: (v) => v[0], iotaCode: "0101011" },
  {
    sym: "S",
    lawText: "S x y z = x z (y z)",
    arity: 3,
    reference: (v) => app(app(v[0], v[2]), app(v[1], v[2])),
    iotaCode: "010101011",
  },
  {
    sym: "X",
    lawText: "X x y = x y x",
    arity: 2,
    reference: (v) => app(app(v[0], v[1]), v[0]),
    iotaCode: "01010101011",
  },
];
