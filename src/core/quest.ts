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

function toStage(p: Puzzle): QuestStage {
  return {
    id: p.id,
    name: p.name,
    intro: asLines(p.intro),
    hint: p.hint,
    goal: makeGoal(p),
    unlock: p.unlock && CATALOG_SYMS.has(p.unlock) ? p.unlock : undefined,
  };
}

/** The chapters, built from the vendored SKI-Quest data. Puzzles Combinate can't yet
 *  check on its single canvas (multi-term builds, structural-property goals) are left
 *  out — every chapter still has its core stages. */
export const CHAPTERS: QuestChapter[] = SKIQ_CHAPTERS.map((c) => ({
  id: c.id,
  name: c.name,
  blurb: blurbOf(c.intro),
  stages: c.content.filter(isSupported).map(toStage),
})).filter((c) => c.stages.length > 0);

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

const STORE_KEY = "combinate:quest:v3"; // v1/v2 were the bespoke pre-SKI-Quest chapters

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
