/**
 * Gamepad input (ADR 17), designed with the Magi council (consensus). A third input producer
 * parallel to mouse + keyboard. Polled every frame so a pad is always detectable (Y enters/exits
 * 3D) and the hints can flip to pad glyphs the moment it's used. The Gamepad API is poll-based,
 * so we sample `navigator.getGamepads()` fresh every Pixi-ticker frame (never cache the snapshot),
 * edge-detect the discrete buttons (with keyboard-style time-based auto-repeat for the d-pad) and
 * read the sticks/triggers as analog — then drive intents per the active context
 * ({@link intentForPad}) through a thin sink on app.ts. The button → intent map lives in
 * `keymap.ts` (the single source); only the edge/repeat/analog semantics live here. Connection
 * events are only discovery/toast hints; the poll loop is the source of truth (Chrome withholds
 * pads until first input). Every real action calls `sink.note()` so the device tracker switches
 * the hints to gamepad glyphs (last-input-wins).
 */
import { type Ticker } from "pixi.js";
import { type Context, type Intent, intentForPad, PAD_BUTTON as BTN } from "./keymap";

const AXIS_LX = 0;
const AXIS_LY = 1;
const AXIS_RX = 2;
const AXIS_RY = 3;

const DEADZONE = 0.25; // stick radial deadzone (rescaled past it)
const ZOOM_RATE = 2.6; // e^(rate·dt·trigger) per second at full trigger
const TRIGGER_MIN = 0.12; // ignore trigger noise below this
const REPEAT_DELAY = 380; // ms a d-pad direction is held before it auto-repeats
const REPEAT_RATE = 110; // ms between auto-repeats
const MAX_DT = 50; // clamp a frame delta (a hidden-tab resume yields a huge one → no input storm / camera fly-off)

// Buttons that fire once per press (edge); the d-pad (12-15) auto-repeats and is handled separately.
const EDGE_BUTTONS = [BTN.A, BTN.B, BTN.X, BTN.Y, BTN.LB, BTN.RB, BTN.SELECT, BTN.R3];
const DPAD = [BTN.DUP, BTN.DDOWN, BTN.DLEFT, BTN.DRIGHT];

/** What the gamepad drives — the app routes each by the active context. Analog values are the
 *  deadzone-rescaled stick vector ([-1,1]) + the frame dt; the sink owns the rate/sign per use. */
export interface GamepadSink {
  context: () => Context; // which context — picks the button→intent map
  dispatch: (intent: Intent) => void; // a discrete intent, routed per context
  leftStick: (sx: number, sy: number, dt: number) => void; // inspect: orbit
  rightStick: (sx: number, sy: number, dt: number) => void; // build: pan camera
  zoomBy: (factor: number) => void; // triggers (RT in, LT out)
  note: () => void; // a real pad action happened → device tracker
  toast: (msg: string) => void;
}

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
    const dt = Math.min(dtMs, MAX_DT) / 1000;
    this.clock += Math.min(dtMs, MAX_DT);
    const pad = this.pick();
    if (!pad) {
      this.prev = [];
      return;
    }
    const ctx = this.sink.context();
    const pressed = (i: number): boolean => pad.buttons[i]?.pressed ?? false;
    const edge = (i: number): boolean => pressed(i) && !(this.prev[i] ?? false);
    const fire = (intent: Intent | null): void => {
      if (!intent) return;
      this.sink.dispatch(intent);
      this.sink.note();
    };

    for (const i of EDGE_BUTTONS) if (edge(i)) fire(intentForPad(ctx, i));
    for (const i of DPAD) this.navRepeat(i, ctx, pressed(i));

    // left stick → orbit (inspect); right stick → pan (build). The sink owns rate/sign per context.
    const l = this.stick(pad.axes[AXIS_LX] ?? 0, pad.axes[AXIS_LY] ?? 0);
    if (l) {
      this.sink.leftStick(l.x, l.y, dt);
      this.sink.note();
    }
    const r = this.stick(pad.axes[AXIS_RX] ?? 0, pad.axes[AXIS_RY] ?? 0);
    if (r) {
      this.sink.rightStick(r.x, r.y, dt);
      this.sink.note();
    }
    // triggers → zoom (RT in, LT out), analog, exponential-per-second
    const z = (pad.buttons[BTN.RT]?.value ?? 0) - (pad.buttons[BTN.LT]?.value ?? 0);
    if (Math.abs(z) > TRIGGER_MIN) {
      this.sink.zoomBy(Math.exp(ZOOM_RATE * dt * z));
      this.sink.note();
    }

    this.prev = pad.buttons.map((b) => b.pressed);
  }

  // Radial deadzone + rescale; null below the deadzone (no input → no device flip).
  private stick(x: number, y: number): { x: number; y: number } | null {
    const mag = Math.hypot(x, y);
    if (mag <= DEADZONE) return null;
    const k = (mag - DEADZONE) / (1 - DEADZONE) / mag;
    return { x: x * k, y: y * k };
  }

  // A d-pad direction: fire on press, then auto-repeat after a hold (time-based, so a slow or a
  // resumed frame can't double-fire). Held-but-not-due and released both no-op.
  private navRepeat(i: number, ctx: Context, down: boolean): void {
    if (!down) return;
    const fire = (): void => {
      const intent = intentForPad(ctx, i);
      if (!intent) return;
      this.sink.dispatch(intent);
      this.sink.note();
    };
    const was = this.prev[i] ?? false;
    if (!was) {
      fire();
      this.repeatAt[i] = this.clock + REPEAT_DELAY;
    } else if (this.clock >= (this.repeatAt[i] ?? Infinity)) {
      fire();
      this.repeatAt[i] = this.clock + REPEAT_RATE;
    }
  }
}
