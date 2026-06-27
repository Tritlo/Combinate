/**
 * The Quest (a Special): a guided progression that walks the player from the
 * single generator ι out to the SKI basis and a few values — "everything from
 * one". Adapted, with permission, from Konstantin S. Uvarin's SKI Quest
 * (https://dallaylaen.github.io/ski-interpreter/quest.html): the format (a chapter
 * of "build a term that satisfies this goal" puzzles) is his; the ι-flavoured
 * content is ours.
 *
 * Pure — no DOM/Pixi. A stage's `goal` is a behavioural predicate over the built
 * tree (the same machinery the Zoo probe and Golf challenges use): the shell calls
 * {@link QuestProgress.check} when a tree settles, advances on a solve, and reveals
 * the stage's `unlock` combinator.
 */
import { type Node } from "./term";
import { probe } from "./probe";
import { CATALOG, type Law } from "./catalog";
import { matchNumeral, matchBool } from "./value";

const LAW = new Map(CATALOG.map((l) => [l.sym, l] as const));

/** Goal: the built tree behaves as the named combinator (behavioural probe). */
const behavesAs = (sym: string) => (n: Node): boolean => probe(n, LAW.get(sym) as Law);
/** Goal: the built tree reduces to the Scott numeral `k`. */
const reducesToNumeral = (k: number) => (n: Node): boolean => matchNumeral(n) === k;
/** Goal: the built tree reduces to the Scott boolean `b`. */
const reducesToBool = (b: boolean) => (n: Node): boolean => matchBool(n) === b;

/** One stage of the quest: a goal to satisfy by building a tree, wrapped in story. */
export interface QuestStage {
  /** Stable id (progress key). */
  id: string;
  /** Short title. */
  name: string;
  /** HTML lines of narrative / the task. */
  intro: string[];
  /** Spoiler hint, shown on demand. */
  hint: string;
  /** Does this built (settled) tree solve the stage? */
  goal: (built: Node) => boolean;
  /** Combinator symbol to reveal (discover) when the stage is solved. */
  unlock?: string;
}

/** The "From One" chapter — build the SKI basis (and a little more) out of ι. */
export const QUEST: QuestStage[] = [
  {
    id: "identity",
    name: "Out of One",
    intro: [
      "<p>Everything here grows from a single seed: <b>ι</b>, where <code>ι x = x S K</code>.</p>",
      "<p>Your first task is the simplest combinator of all — the <b>Identity</b>, <code>I x = x</code>.",
      "It needs no <code>S</code>, no <code>K</code>, nothing but ι.</p>",
      "<p>Drag an ι from the hotbar, then snap a second ι onto it. Watch what it becomes.</p>",
    ],
    hint: "ι applied to itself:  ι ι.",
    goal: behavesAs("I"),
    unlock: "I",
  },
  {
    id: "kestrel",
    name: "The Kestrel",
    intro: [
      "<p>The <b>Kestrel</b> <code>K x y = x</code> keeps its first argument and forgets the second.</p>",
      "<p>It too hides inside ι — you just have to feed ι to ι a few times.</p>",
    ],
    hint: "ι (ι (ι ι)).",
    goal: behavesAs("K"),
    unlock: "K",
  },
  {
    id: "starling",
    name: "The Starling",
    intro: [
      "<p>The <b>Starling</b> <code>S x y z = x z (y z)</code> is the last piece of the basis —",
      "with <code>S</code> and <code>K</code> you can write <i>any</i> combinator at all.</p>",
      "<p>It is one ι deeper than the Kestrel.</p>",
    ],
    hint: "ι (ι (ι (ι ι))).",
    goal: behavesAs("S"),
    unlock: "S",
  },
  {
    id: "truth",
    name: "Truth",
    intro: [
      "<p>With the basis in hand, you can build <i>data</i>. In the Scott encoding a boolean",
      "chooses between two branches: <b>True</b> keeps the first.</p>",
      "<p>You may notice you have already built True once before…</p>",
      "<p>Build a tree that reduces to <b>True</b>.</p>",
    ],
    hint: "True is exactly K.",
    goal: reducesToBool(true),
  },
  {
    id: "two",
    name: "Two",
    intro: [
      "<p>Numbers, too, are just trees. A Scott numeral is <code>Z</code> (zero) wrapped in",
      "<code>Succ</code>s. Here <b>Z = K</b> and <b>Succ = S</b>.</p>",
      "<p>Build a tree that reduces to the number <b>2</b> — that is, <code>Succ (Succ Z)</code>.</p>",
    ],
    hint: "S (S K) — two Succs around a Zero.",
    goal: reducesToNumeral(2),
  },
  {
    id: "mockingbird",
    name: "The Mockingbird",
    intro: [
      "<p>One last bird for the road. The <b>Mockingbird</b> <code>M x = x x</code> hands a thing",
      "to itself — the seed of self-reference (and of never-ending reduction).</p>",
      "<p>Build a tree that behaves as <code>M</code>. You have every piece you need.</p>",
    ],
    hint: "S I I  —  S applied to I and I.",
    goal: behavesAs("M"),
    unlock: "M",
  },
];

const STORE_KEY = "combinate:quest:v1";

/** Tracks how far the player has got, persisted to localStorage. */
export class QuestProgress {
  /** Index of the current (unsolved) stage; === QUEST.length when finished. */
  stage = 0;

  constructor() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) this.stage = Math.max(0, Math.min(QUEST.length, JSON.parse(raw) as number));
    } catch {
      /* ignore */
    }
  }

  get done(): boolean {
    return this.stage >= QUEST.length;
  }
  get current(): QuestStage | null {
    return this.done ? null : QUEST[this.stage];
  }

  /** A tree settled at normal form — if it solves the current stage, advance and
   *  return the stage that was just solved (so the shell can unlock + announce). */
  check(built: Node): QuestStage | null {
    const stage = this.current;
    if (!stage) return null;
    let ok = false;
    try {
      ok = stage.goal(built);
    } catch {
      ok = false;
    }
    if (!ok) return null;
    this.stage += 1;
    this.save();
    return stage;
  }

  private save(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.stage));
    } catch {
      /* ignore */
    }
  }
}
