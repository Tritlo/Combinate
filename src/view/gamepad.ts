/**
 * Gamepad input (ADR 17), designed with the Magi council (consensus). A third input producer
 * parallel to mouse + keyboard, active only while game mode is on. The Gamepad API is poll-
 * based, so we sample `navigator.getGamepads()` fresh every Pixi-ticker frame (never cache the
 * snapshot), edge-detect the discrete buttons (with keyboard-style time-based auto-repeat for
 * the d-pad) and read the sticks/triggers as dt-scaled analog — then drive the SAME intents as
 * the keyboard through a thin sink on the `GameInputController`. The W3C "standard" button/axis
 * indices live here (not in `keymap.ts`) because they carry edge/repeat/analog semantics a key
 * list can't. Connection events are only discovery/toast hints; the poll loop is the source of
 * truth (Chrome withholds pads until first input).
 */
import { type Ticker } from "pixi.js";
import { type Intent } from "./keymap";

// W3C "standard" gamepad layout.
const BTN = { A: 0, B: 1, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15 };
const AXIS_RX = 2;
const AXIS_RY = 3;

const DEADZONE = 0.25; // right-stick radial deadzone (rescaled past it)
const PAN_RATE = 1100; // world px/sec at full stick deflection
const ZOOM_RATE = 2.6; // e^(rate·dt·trigger) per second at full trigger
const TRIGGER_MIN = 0.12; // ignore trigger noise below this
const REPEAT_DELAY = 380; // ms a d-pad direction is held before it auto-repeats
const REPEAT_RATE = 110; // ms between auto-repeats
const MAX_DT = 50; // clamp a frame delta (a hidden-tab resume yields a huge one → no input storm / camera fly-off)

/** What the gamepad drives — the same actions the keyboard reaches, plus analog + speed-cycle. */
export interface GamepadSink {
  enabled: () => boolean; // game mode on?
  trigger: (intent: Intent) => void;
  panBy: (dx: number, dy: number) => void;
  zoomBy: (factor: number) => void;
  cycleSpeed: () => void;
  toast: (msg: string) => void;
}

// Discrete buttons fired once per press (edge), and the d-pad directions that auto-repeat.
const EDGE: Array<[number, Intent]> = [
  [BTN.A, "pickPlace"],
  [BTN.B, "cancel"],
  [BTN.LB, "applyFn"],
  [BTN.RB, "applyArg"],
];
const NAV: Array<[number, Intent]> = [
  [BTN.DLEFT, "moveLeft"],
  [BTN.DRIGHT, "moveRight"],
  [BTN.DUP, "moveUp"],
  [BTN.DDOWN, "moveDown"],
];

export class GamepadController {
  private padIndex: number | null = null;
  private prev: boolean[] = []; // last frame's button-pressed states
  private repeatAt: Record<number, number> = {}; // button index → clock time of its next auto-repeat
  private clock = 0; // accumulated (clamped) ms — drives repeat timing without Date/perf.now
  private warnedNonStandard = false;

  constructor(ticker: Ticker, private readonly sink: GamepadSink) {
    ticker.add((tk) => this.poll(tk.deltaMS));
    window.addEventListener("gamepadconnected", (e) => {
      const g = (e as GamepadEvent).gamepad;
      this.sink.toast(g.mapping === "standard" ? "controller connected" : "controller connected — non-standard, keyboard recommended");
    });
    window.addEventListener("gamepaddisconnected", () => this.reset());
  }

  private reset(): void {
    this.padIndex = null;
    this.prev = [];
    this.repeatAt = {};
  }

  // Fresh each frame: the active pad is the lowest-index connected "standard" one (sticky to the
  // tracked index while it stays valid). Null entries + index reuse after replug are handled here.
  private pick(): Gamepad | null {
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return null; // getGamepads can throw under a Permissions-Policy block
    }
    const ok = (g: Gamepad | null): g is Gamepad => !!g && g.connected && g.mapping === "standard";
    if (this.padIndex !== null && ok(pads[this.padIndex])) return pads[this.padIndex];
    for (let i = 0; i < pads.length; i++) {
      if (ok(pads[i])) {
        this.padIndex = i;
        return pads[i];
      }
    }
    // a pad is present but none are standard → one-time hint, then ignore
    if (!this.warnedNonStandard && pads.some((g) => g && g.connected)) {
      this.warnedNonStandard = true;
      this.sink.toast("controller has a non-standard mapping — use the keyboard");
    }
    this.padIndex = null;
    return null;
  }

  private poll(dtMs: number): void {
    if (!this.sink.enabled()) {
      this.prev = [];
      return; // game mode off — don't even touch the Gamepad API
    }
    const dt = Math.min(dtMs, MAX_DT) / 1000;
    this.clock += Math.min(dtMs, MAX_DT);
    const pad = this.pick();
    if (!pad) {
      this.prev = [];
      return;
    }
    const pressed = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
    const edge = (i: number): boolean => pressed(i) && !(this.prev[i] ?? false);

    for (const [i, intent] of EDGE) if (edge(i)) this.sink.trigger(intent);
    if (edge(BTN.SELECT)) this.sink.cycleSpeed();
    for (const [i, intent] of NAV) this.navRepeat(i, intent, pressed(i));

    // right stick → pan (radial deadzone, rescaled; matches the keyboard pan signs)
    const rx = pad.axes[AXIS_RX] ?? 0;
    const ry = pad.axes[AXIS_RY] ?? 0;
    const mag = Math.hypot(rx, ry);
    if (mag > DEADZONE) {
      const k = (((mag - DEADZONE) / (1 - DEADZONE)) / mag) * PAN_RATE * dt;
      this.sink.panBy(-rx * k, -ry * k); // push right/down ⇒ view pans right/down
    }
    // triggers → zoom (RT in, LT out), analog values, exponential-per-second
    const z = (pad.buttons[BTN.RT]?.value ?? 0) - (pad.buttons[BTN.LT]?.value ?? 0);
    if (Math.abs(z) > TRIGGER_MIN) this.sink.zoomBy(Math.exp(ZOOM_RATE * dt * z));

    this.prev = pad.buttons.map((b) => b.pressed);
  }

  // A d-pad direction: fire on press, then auto-repeat after a hold (time-based, so a slow or a
  // resumed frame can't double-fire). Held-but-not-due and released both no-op.
  private navRepeat(i: number, intent: Intent, down: boolean): void {
    if (!down) return;
    const was = this.prev[i] ?? false;
    if (!was) {
      this.sink.trigger(intent);
      this.repeatAt[i] = this.clock + REPEAT_DELAY;
    } else if (this.clock >= (this.repeatAt[i] ?? Infinity)) {
      this.sink.trigger(intent);
      this.repeatAt[i] = this.clock + REPEAT_RATE;
    }
  }
}
