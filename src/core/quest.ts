/**
 * The Quest — Combinate's main game: the full SKI Quest, adapted (with permission)
 * from Konstantin S. Uvarin's original (https://dallaylaen.github.io/ski-interpreter/).
 * The chapter/puzzle content is vendored in {@link import("./skiq/data")} and checked
 * by {@link import("./skiq/engine")} (the puzzles' little SKI expressions, run on
 * Combinate's own reducer). Here we shape that data into the chapter/stage model the
 * panel renders, and track progress.
 *
 * Pure — no DOM/Pixi. A stage's `goal` is a predicate over the *built* (settled)
 * tree: the shell calls {@link QuestProgress.check} when a tree settles, advances on
 * a solve, and reveals the stage's `unlock` combinator (when it's a catalog bird).
 */
import { type Node } from "./term";
import { CATALOG } from "./catalog";
import { SKIQ_CHAPTERS } from "./skiq/data";
import { makeGoal, isSupported, type Puzzle } from "./skiq/engine";
import { SOLUTIONS } from "./skiq/solutions";

/** One stage of the quest: a goal to satisfy by building a tree, wrapped in story. */
export interface QuestStage {
  /** Stable id (progress key). */
  id: string;
  /** Short title. */
  name: string;
  /** HTML lines of narrative / the task. */
  intro: string[];
  /** Spoiler hint (HTML), shown on demand; absent when the puzzle has none. */
  hint?: string;
  /** A recorded solution source (SKI-Quest notation) from the answer key, revealed in the review of a
   *  solved stage; absent when none is on file. See {@link import("./skiq/solutions").SOLUTIONS}. */
  solution?: string;
  /** Does this built (settled) tree solve the stage? */
  goal: (built: Node) => boolean;
  /** Combinator symbol to reveal (discover) when solved — only catalog birds. */
  unlock?: string;
}

/** A chapter: a themed run of stages that share a setting and build on the last. */
export interface QuestChapter {
  /** Stable id. */
  id: string;
  /** Chapter title (shown in the panel titlebar + eyebrow). */
  name: string;
  /** One-line framing, shown under the title on the chapter's first stage. */
  blurb: string;
  /** The stages, in order. */
  stages: QuestStage[];
}

const CATALOG_SYMS = new Set(CATALOG.map((l) => l.sym));

const asLines = (intro: string | string[]): string[] => (Array.isArray(intro) ? intro : [intro]);

/** First plain-text sentence of a chapter intro, for the under-title blurb. */
function blurbOf(intro: string | string[]): string {
  const text = asLines(intro).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const stop = text.indexOf(". ");
  return stop > 0 ? text.slice(0, stop + 1) : text.slice(0, 160);
}

/** Combinate-authored hints for SKI-Quest stages that shipped without one, keyed by puzzle id
 *  (chapters 2–4 so far). Each is a nudge toward the approach — not the term — matching the voice +
 *  spoiler level of the puzzles' own hints; the Prologue keeps the tutorial-level spoilers. */
const HINT_OVERRIDES: Record<string, string> = {
  // Ch 2 · Baby steps
  UZdEyeiN: "This is composition; make S's left branch ignore the extra x.", // Join em!
  DADG8des: "Reuse the Join em shape twice: first h into g, then into f.", // Join em harder
  VbnUGtfn: "Use S: one branch keeps f, the other supplies the fixed x.", // Feeding a birdie
  T89a9q7G: "Peel off the ignored arguments with K until an I is waiting.", // May the force be with you
  "4LmjXm1E": "Use S so y reaches f, while K keeps x fixed.", // Between the rock and a hard place
  hiwf2WWz: "Let M make the first double; the other branch leaves x alone.", // Triplication
  fvQITKZd: "Use S to duplicate y: one copy acts, the other feeds x.", // A parliament of owls
  // Ch 3 · Swing, swing!
  zhxYRTMO: "Keep x aside with K, then let the next argument call it.", // Mirror image
  LAhD47Yg: "After x arrives, let S feed the next argument to both x and I.", // What you like, do once more!
  cKg6FHW9: "Hide M behind K, so x x waits for the second argument.", // K forte
  WiTB9Xy0: "Compose T one level deeper: make y z before swinging x behind.", // Round Robin
  Qq7dQfBW: "Build x z first, then use T to place y after it.", // Éminence grise (Cardinal)
  glGifOC9: "Compose Cardinal with Thrush: first swap, then flip the last pair.", // Double patience (Vireo)
  WhYIkSJR: "Use V to put d before a and b, then append c.", // The trident of Poseidon
  // Ch 4 · The BCKW forest
  EERaTEWg: "W needs two identical inputs; feed it a K.", // Where am I? (build I)
  DZgmxmiQ: "One B builds z t; another feeds that result to x y.", // Dove
  "2LpsCjKe": "W can duplicate a; then route b as both caller and final argument.", // The Turing bird
  fGRC4aUm: "Discard b, swap d before c, and duplicate a at the front.", // ADAC
  NPQ1PIwx: "Duplicate c: one copy builds b c, the other feeds a.", // Can't think of a name
  SDFiIPyt: "W duplicates z; B builds the two branches, C fixes their order.", // The way back home (build S)
};

function toStage(p: Puzzle): QuestStage {
  return {
    id: p.id,
    name: p.name,
    intro: asLines(p.intro),
    hint: p.hint ?? HINT_OVERRIDES[p.id],
    solution: SOLUTIONS[p.id],
    goal: makeGoal(p),
    unlock: p.unlock && CATALOG_SYMS.has(p.unlock) ? p.unlock : undefined,
  };
}

// A Combinate-native Prologue: the SKI Quest starts you with S/K/I already in hand,
// but here you begin with a single block — ι — so first grow the basis from it. And
// it is ι all the way: each combinator is ι fed the one before it, the Barker tower
//   ι ι = I,  ι I = A,  ι A = K,  ι K = S.
// `allow` is set to ι plus the birds unlocked so far — exactly what is on the hotbar
// at each stage — so "feed ι the bird you just made" works (and so does a pure-ι
// build, since ι is always permitted). Solving each discovers the bird, so the
// inventory the Quest assumes is genuinely earned.
const PROLOGUE: Puzzle[] = [
  {
    id: "prologue-i",
    name: "Out of One",
    allow: "I-I", // you start with nothing but ι
    unlock: "I",
    input: "phi",
    intro: [
      "<p>Welcome. Everything in Combinate grows from a single seed: <b>ι</b>, where <code>ι x = x S K</code>. Drag one from the hotbar, snap a second onto it, and watch it reduce.</p>",
      "<p>Your first bird is the <b>Identity</b> — <code>I x = x</code> hands back whatever it is given. It is the cheapest thing there is: ι applied to itself.</p>",
    ],
    hint: "<code>ι ι</code>",
    cases: [["phi x", "x"]],
  },
  {
    id: "prologue-a",
    name: "The Mirror",
    allow: "I", // ι + the Identity you just unlocked
    unlock: "A",
    input: "phi",
    intro: [
      "<p>Now feed ι the bird you just made. <b>ι I</b> gives <b>A</b> — <code>A x y = y</code>, the mirror of the Kestrel: it keeps the <i>second</i> argument (the Scott <b>True</b>).</p>",
      "<p>Drag an ι onto your <code>I</code>.</p>",
    ],
    hint: "<code>ι I</code>  — feed ι the Identity (or, all in ι: <code>ι (ι ι)</code>)",
    cases: [["phi x y", "y"]],
  },
  {
    id: "prologue-k",
    name: "The Kestrel",
    allow: "IA", // ι + I + the Mirror
    unlock: "K",
    input: "phi",
    intro: [
      "<p>Feed ι to <b>A</b> and the <b>Kestrel</b> appears — <code>K x y = x</code>, which keeps the first argument and forgets the second.</p>",
    ],
    hint: "<code>ι A</code>  — feed ι the Mirror (or <code>ι (ι (ι ι))</code>)",
    cases: [["phi x y", "x"]],
  },
  {
    id: "prologue-s",
    name: "The Starling",
    allow: "IAK", // ι + I + A + the Kestrel
    unlock: "S",
    input: "phi",
    intro: [
      "<p>One more. Feed ι to the <b>Kestrel</b> and out comes the <b>Starling</b> — <code>S x y z = x z (y z)</code>. With <code>S</code> and <code>K</code> you can spell <i>any</i> combinator at all; everything in the Quest ahead is built from here.</p>",
    ],
    hint: "<code>ι K</code>  — feed ι the Kestrel (or <code>ι (ι (ι (ι ι)))</code>)",
    cases: [["phi x y z", "x z (y z)"]],
  },
];

const PROLOGUE_CHAPTER: QuestChapter = {
  id: "prologue",
  name: "Prologue",
  blurb: "Ex uno plures — from one, many. Combinate begins with a single seed, ι. Feed it to itself and the whole basis unfolds: I, then A, then K, then S.",
  stages: PROLOGUE.map(toStage),
};

// The SKI-Quest "island of Iota" chapter derives I/K/S from ι (allow:"I-I") — which
// is exactly what the Prologue now does, and Combinate already builds everything from
// ι. Dropped to avoid the redundancy.
const DROP_CHAPTERS = new Set(["NJpjdogX"]);

/** Drop a stage that re-unlocks a bird an earlier stage already gave — e.g. the SKIQ
 *  basis stage that rebuilds I (= the Prologue's job), which is redundant now that the
 *  ι Prologue already discovers I/A/K/S. Stages with no unlock are always kept. */
function dedupeUnlocks(chapters: QuestChapter[]): QuestChapter[] {
  const seen = new Set<string>();
  return chapters
    .map((c) => ({
      ...c,
      stages: c.stages.filter((s) => {
        if (s.unlock && seen.has(s.unlock)) return false;
        if (s.unlock) seen.add(s.unlock);
        return true;
      }),
    }))
    .filter((c) => c.stages.length > 0);
}

/** The chapters: the ι→basis Prologue, then the SKI-Quest proper (vendored data).
 *  Puzzles Combinate can't yet check on its single canvas (multi-term builds,
 *  structural-property goals) are left out — every chapter still has its core stages. */
export const CHAPTERS: QuestChapter[] = dedupeUnlocks([
  PROLOGUE_CHAPTER,
  ...SKIQ_CHAPTERS.filter((c) => !DROP_CHAPTERS.has(c.id)).map((c) => ({
    id: c.id,
    name: c.name,
    blurb: blurbOf(c.intro),
    stages: c.content.filter(isSupported).map(toStage),
  })),
]);

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

/** Tracks how far the player has got. Pure (ADR 0001): persistence is injected — the
 *  shell loads the starting stage and supplies a `persist` callback (so `core/` does no
 *  localStorage of its own). */
export class QuestProgress {
  /** Index of the current (unsolved) stage; === QUEST.length when finished. */
  stage: number;

  constructor(initial = 0, private readonly persist: (stage: number) => void = () => {}) {
    this.stage = Math.max(0, Math.min(QUEST.length, initial));
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
    this.persist(this.stage);
    return stage;
  }

  /** Start the quest over (back to the Prologue). */
  reset(): void {
    this.stage = 0;
    this.persist(0);
  }
}
