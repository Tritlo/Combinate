/**
 * The Quest (Combinate's main game): a chaptered progression that walks the player
 * from the single generator ι out through the SKI basis, a charm of birds, logic,
 * and numbers — "everything from one". Adapted, with permission, from Konstantin S.
 * Uvarin's SKI Quest (https://dallaylaen.github.io/ski-interpreter/quest.html): the
 * format (chapters of "build a term that satisfies this goal" puzzles) is his; the
 * ι-flavoured content — and the fact that each chapter only uses what earlier ones
 * unlocked — is ours.
 *
 * Pure — no DOM/Pixi. A stage's `goal` is a behavioural predicate over the built
 * tree (the shared {@link import("./goals")} machinery the Zoo probe and Golf use):
 * the shell calls {@link QuestProgress.check} when a tree settles, advances on a
 * solve, and reveals the stage's `unlock` combinator.
 */
import { type Node } from "./term";
import { behavesAs, reducesToNumeral, reducesToBool, fn, tru, fls, outBool } from "./goals";

// Function goals are re-checked on every settle; bound their reduction so a stray
// divergent build can't stall the loop (the real ones finish in well under this).
const BUDGET = 20_000;

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

/** A chapter: a themed run of stages that share a setting and build on the last. */
export interface QuestChapter {
  /** Stable id. */
  id: string;
  /** Chapter title (shown in the panel titlebar + eyebrow). */
  name: string;
  /** One-line framing, shown under the title. */
  blurb: string;
  /** The stages, in order. */
  stages: QuestStage[];
}

export const CHAPTERS: QuestChapter[] = [
  {
    id: "from-one",
    name: "From One",
    blurb: "A single seed — ι, where ι x = x S K. The whole basis is hiding inside it.",
    stages: [
      {
        id: "identity",
        name: "Out of One",
        intro: [
          "<p>Everything here grows from one seed: <b>ι</b>, where <code>ι x = x S K</code>.</p>",
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
    ],
  },
  {
    id: "birds",
    name: "A Charm of Birds",
    blurb: "With S, K and I you can spell any combinator. Time to grow the aviary.",
    stages: [
      {
        id: "mockingbird",
        name: "The Mockingbird",
        intro: [
          "<p>The <b>Mockingbird</b> <code>M x = x x</code> hands a thing to itself — the seed of",
          "self-reference (and of reductions that never end).</p>",
          "<p>Build a tree that behaves as <code>M</code>. You have every piece you need.</p>",
        ],
        hint: "S I I  —  S applied to I and I.",
        goal: behavesAs("M"),
        unlock: "M",
      },
      {
        id: "bluebird",
        name: "The Bluebird",
        intro: [
          "<p>The <b>Bluebird</b> <code>B x y z = x (y z)</code> is pure <i>composition</i>: do <code>y</code>,",
          "then <code>x</code>. Nearly everything downstream is built from it.</p>",
          "<p>Build a tree that behaves as <code>B</code>.</p>",
        ],
        hint: "S (K S) K.",
        goal: behavesAs("B"),
        unlock: "B",
      },
      {
        id: "cardinal",
        name: "The Cardinal",
        intro: [
          "<p>The <b>Cardinal</b> <code>C x y z = x z y</code> swaps the last two arguments — a flip.",
          "It is exactly the Scott <code>if</code>: <code>if c t e = c e t</code>.</p>",
          "<p>Build a tree that behaves as <code>C</code>.</p>",
        ],
        hint: "S (S (K (S (K S) K)) S) (K K)  —  or just build something that flips and let the zoo name it.",
        goal: behavesAs("C"),
        unlock: "C",
      },
      {
        id: "thrush",
        name: "The Thrush",
        intro: [
          "<p>The <b>Thrush</b> <code>T x y = y x</code> applies its argument <i>to</i> its function —",
          "the flip with nothing in front. A one-liner now that you have the Cardinal.</p>",
          "<p>Build a tree that behaves as <code>T</code>.</p>",
        ],
        hint: "C I  —  the Cardinal applied to the Identity.",
        goal: behavesAs("T"),
        unlock: "T",
      },
    ],
  },
  {
    id: "logic",
    name: "True or False",
    blurb: "Data is just trees. A boolean is a choice between two branches — and from a choice, all of logic.",
    stages: [
      {
        id: "truth",
        name: "Truth",
        intro: [
          "<p>In the Scott encoding a boolean picks one of two branches. <b>True</b> takes the",
          "second; <b>False</b> (which is just <code>K</code>) takes the first.</p>",
          "<p>Build a tree that reduces to <b>True</b>.</p>",
        ],
        hint: "True is K I  (the catalog calls this bird A).",
        goal: reducesToBool(true),
        unlock: "A",
      },
      {
        id: "negation",
        name: "Not",
        intro: [
          "<p><b>not</b> flips a boolean: <code>not True = False</code>, <code>not False = True</code>.</p>",
          "<p>A boolean already chooses between two things — so just hand it the answers,",
          "swapped. Build a tree that behaves as <code>not</code>.</p>",
        ],
        hint: "not b = b True False — feed the boolean True then False and let it pick.",
        goal: fn([{ in: [tru()], out: outBool(false) }, { in: [fls()], out: outBool(true) }], BUDGET),
        unlock: "not",
      },
      {
        id: "conjunction",
        name: "And",
        intro: [
          "<p><b>and</b> is True only when both inputs are. Read it as a choice:",
          "<i>if p then q else False</i>.</p>",
          "<p>Build a tree that behaves as <code>and</code>.</p>",
        ],
        hint: "and p q = p q False — if p picks, hand back q; otherwise False.",
        goal: fn(
          [
            { in: [tru(), tru()], out: outBool(true) },
            { in: [tru(), fls()], out: outBool(false) },
            { in: [fls(), tru()], out: outBool(false) },
            { in: [fls(), fls()], out: outBool(false) },
          ],
          BUDGET,
        ),
        unlock: "and",
      },
      {
        id: "disjunction",
        name: "Or",
        intro: [
          "<p><b>or</b> is True when either input is. <i>if p then True else q</i>.</p>",
          "<p>Build a tree that behaves as <code>or</code>.</p>",
        ],
        hint: "or p q = p True q.",
        goal: fn(
          [
            { in: [tru(), tru()], out: outBool(true) },
            { in: [tru(), fls()], out: outBool(true) },
            { in: [fls(), tru()], out: outBool(true) },
            { in: [fls(), fls()], out: outBool(false) },
          ],
          BUDGET,
        ),
        unlock: "or",
      },
    ],
  },
  {
    id: "numbers",
    name: "Numbers",
    blurb: "Count with trees: zero is K, and every number is one more wrapped around it.",
    stages: [
      {
        id: "successor",
        name: "The Successor",
        intro: [
          "<p>A Scott numeral is <b>Zero</b> (which is <code>K</code>) wrapped in <b>Succ</b>s. <code>Succ</code>",
          "takes a number and hands it to the “add one” branch.</p>",
          "<p>Build a tree that behaves as <code>Succ</code> — and notice it is made entirely",
          "of birds you have already met.</p>",
        ],
        hint: "Succ = B K T  —  the Bluebird, the Kestrel, the Thrush.",
        goal: behavesAs("Succ"),
        unlock: "Succ",
      },
      {
        id: "three",
        name: "Three",
        intro: [
          "<p>Now use the tool you just made. <b>Three</b> is <code>Succ (Succ (Succ Zero))</code>,",
          "and Zero is <code>K</code>.</p>",
          "<p>Build a tree that reduces to the number <b>3</b>.</p>",
        ],
        hint: "Succ (Succ (Succ K)).",
        goal: reducesToNumeral(3),
      },
      {
        id: "predecessor",
        name: "The Predecessor",
        intro: [
          "<p>Going forward was easy; going back is the famous one. <b>Pred</b> peels off one",
          "<code>Succ</code> — and Zero stays Zero.</p>",
          "<p>Build a tree that behaves as <code>Pred</code>.</p>",
        ],
        hint: "Pred n = n K I  —  hand the number K (its own Zero) and I; Zero stays K, a successor drops one.",
        goal: behavesAs("Pred"),
        unlock: "Pred",
      },
    ],
  },
];

/** All stages, flattened into play order. */
export const QUEST: QuestStage[] = CHAPTERS.flatMap((c) => c.stages);

/** Where a global stage index sits — its chapter and position within it. */
export interface QuestLocation {
  chapter: QuestChapter;
  /** 0-based chapter number. */
  chapterIndex: number;
  /** 0-based stage number within the chapter. */
  stageInChapter: number;
}

/** Resolve a global stage index to its chapter + offset (null once finished). */
export function locate(stageIndex: number): QuestLocation | null {
  let i = stageIndex;
  for (let c = 0; c < CHAPTERS.length; c++) {
    const ch = CHAPTERS[c];
    if (i < ch.stages.length) return { chapter: ch, chapterIndex: c, stageInChapter: i };
    i -= ch.stages.length;
  }
  return null;
}

const STORE_KEY = "combinate:quest:v2"; // v1 was the flat 6-stage chapter

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
  /** The current stage's chapter context (null once finished). */
  get location(): QuestLocation | null {
    return locate(this.stage);
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
