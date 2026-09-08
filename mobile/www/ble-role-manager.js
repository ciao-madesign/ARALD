// Central/peripheral role arbitration for phone-to-phone Bluetooth relay without an ARALD Clip in
// between — see mobile/README.md, "Design proposto (8 settembre 2026, seguito)" for the full
// reasoning this implements. Real BLE forbids two centrals from connecting directly to each other
// (docs/security.md voce #63's own research, confirmed again for this piece): the plugin currently
// used by this app (@capacitor-community/bluetooth-le, wired in ble-client.js) is central-only, so
// two phones both running that code can never find each other. The design decided with the user is
// event-driven, not a fixed duty-cycle: a phone rests as BLE *peripheral* (discoverable) by default,
// and only becomes *central* (scans/connects out) when it actually has something to send — accepting
// that this drops any peripheral connections it was holding, a deliberate tradeoff the user chose
// ("se ha necessità di invio vuol dire che ha emergenza, quindi priorità... a riposo può stare in
// modalità periferica").
//
// SCOPE OF THIS FILE: only the role/timing state machine — pure logic, no Bluetooth I/O, exactly the
// same split already established between ble-relay.js (pure forwarding/queue logic) and ble-client.js
// (plugin-driven I/O). `onEnterCentral`/`onEnterPeripheral` are injected callbacks the caller wires to
// real plugin calls. THIS FILE DOES NOT WIRE THOSE CALLBACKS TO A REAL PLUGIN — the peripheral role
// requires a plugin capable of BLE advertising/GATT-server mode
// (@capacitor-community/bluetooth-le is central-only, confirmed in mobile/README.md); the candidate
// found, @capgo/capacitor-bluetooth-low-energy, has an API surface this session could not verify in
// enough detail to wire safely (network egress to its documentation/source was blocked — see
// mobile/README.md). Wiring real plugin calls to this state machine is explicitly left as a separate,
// follow-up step once that plugin's actual method signatures can be verified — writing guessed method
// names now would be worse than leaving the boundary explicit, same honesty standard already applied
// throughout this codebase (e.g. node/src/transports/lora-serial.ts, ble-client.js itself) to code
// that has never run against real hardware.
//
// Written as a real ES module (see ble-link.js's own file header for why: testable directly from
// tests/unit/ with vitest, no bundler in mobile/www/) — bridged to `window.AraldBleRoleManager` for
// eventual use from the classic, non-module ble-client.js the same way ble-link.js/ble-relay.js are.

/** Default length of one central-mode attempt (scan+connect window) — within the 8-10s range decided with the user. */
export const DEFAULT_CENTRAL_WINDOW_MS = 9000;
/** Default jittered backoff range before retrying central mode after a failed attempt — "meno frequente di 30s", decided with the user. */
export const DEFAULT_MIN_BACKOFF_MS = 30000;
export const DEFAULT_MAX_BACKOFF_MS = 45000;
/** Default bound on how many attempts one send cycle gets before giving up and falling back to the passive queue (PendingRelayQueue in ble-relay.js) — "durata limitata", decided with the user. */
export const DEFAULT_MAX_ATTEMPTS = 4;
/** Independent overall time bound for one cycle, in case a caller configures a very short backoff — belt-and-braces against a runaway cycle, same "durata limitata" requirement. */
export const DEFAULT_MAX_CYCLE_DURATION_MS = 3 * 60 * 1000;

/**
 * Event-driven central/peripheral role manager. Owns no Bluetooth state itself — every actual radio
 * action happens through the injected `onEnterCentral`/`onEnterPeripheral` callbacks, so this class
 * can be fully unit-tested with fake timers and no plugin at all.
 *
 * State machine (see mobile/README.md for the design this mirrors exactly):
 *   peripheral (rest, default) --requestSend()--> central (attempting, timed window)
 *   central --notifyPeerConnected()--> peripheral (success, cycle ends, attempt counter reset)
 *   central --window expires, budget left--> peripheral (brief jittered backoff) --backoff expires--> central (retry)
 *   central --window expires, budget exhausted--> peripheral (give up, onGiveUp() fires, cycle ends)
 *
 * A generation counter (`#sessionId`) guards every scheduled timer callback — the same defensive
 * pattern already established in ble-client.js's `relaySessionId` — so a timer armed by a cycle that
 * `stop()` (or a later cycle) has since superseded can never act on state that no longer belongs to
 * it. The injected `onEnterCentral`/`onEnterPeripheral` callbacks are deliberately never awaited by
 * this class (see `#callEnterCentral()`/`#callEnterPeripheral()`) — every timing guarantee is armed
 * independently of whether/when they settle, so there is no `await` on them left to guard.
 */
export class BleRoleManager {
  #centralWindowMs;
  #minBackoffMs;
  #maxBackoffMs;
  #maxAttempts;
  #maxCycleDurationMs;
  #onEnterCentral;
  #onEnterPeripheral;
  #onGiveUp;
  #setTimeoutFn;
  #clearTimeoutFn;
  #now;
  #random;

  #role = "peripheral";
  #sessionId = 0;
  #attempt = 0;
  #cycleStartedAt = null;
  #timer = null;
  #started = false;

  constructor(options = {}) {
    this.#centralWindowMs = options.centralWindowMs ?? DEFAULT_CENTRAL_WINDOW_MS;
    this.#minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#maxCycleDurationMs = options.maxCycleDurationMs ?? DEFAULT_MAX_CYCLE_DURATION_MS;
    this.#onEnterCentral = options.onEnterCentral ?? (() => {});
    this.#onEnterPeripheral = options.onEnterPeripheral ?? (() => {});
    this.#onGiveUp = options.onGiveUp ?? (() => {});
    this.#setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.#clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
  }

  get role() {
    return this.#role;
  }

  get isStarted() {
    return this.#started;
  }

  /** Begins at rest (peripheral) — call once when the relay feature itself is activated (mirrors ble-client.js's activateRelay()). */
  async start() {
    if (this.#started) return;
    this.#started = true;
    this.#sessionId += 1;
    this.#role = "peripheral";
    this.#callEnterPeripheral();
  }

  /** Full teardown — cancels any pending timer and invalidates every in-flight callback via the session counter, same guard as ble-client.js's deactivateRelay(). Does not itself call onEnterPeripheral(): the caller is tearing down the whole feature, not asking to rest. */
  stop() {
    this.#started = false;
    this.#sessionId += 1; // invalidates any in-flight onEnterCentral()/onEnterPeripheral() await or scheduled timer
    this.#clearTimer();
    this.#attempt = 0;
    this.#cycleStartedAt = null;
  }

  /**
   * "Necessità di invio" — called for any local outbound need, no priority restriction (decided with
   * the user: "ogni comunicazione fatta attraverso ARALD si suppone sia importante"). No-op if a cycle
   * is already active (already central, or waiting out a backoff window) — every pending send rides
   * the same in-flight cycle, there is no reason to restart it.
   */
  requestSend() {
    if (!this.#started) return;
    if (this.#role === "central" || this.#cycleStartedAt !== null) return; // already trying (central now, or waiting out a backoff before retrying)
    this.#beginCycle();
  }

  /**
   * Central-mode attempt succeeded — a peer was found and connected, so whatever is queued can be
   * flushed to it (the caller's job, e.g. ble-client.js's flushPendingFor()). Ends the cycle
   * immediately and returns to rest, per the user's explicit decision: "sempre ritorno in modalità
   * periferica fissa appena esaurita la coda" — no lingering window, no partial credit.
   *
   * Guarded on `#started` (found missing by code review): without it, a real BLE connect callback
   * that fires shortly after `stop()` — which this class cannot itself cancel, since it does no I/O —
   * would still see the stale `#role === "central"` left behind by `stop()` (deliberately not reset
   * there, see its own comment) and re-invoke `onEnterPeripheral()` on an already-torn-down manager.
   */
  notifyPeerConnected() {
    if (!this.#started) return;
    if (this.#role !== "central") return;
    this.#clearTimer();
    this.#attempt = 0;
    this.#cycleStartedAt = null;
    this.#role = "peripheral";
    this.#callEnterPeripheral();
  }

  #beginCycle() {
    this.#attempt = 0;
    this.#cycleStartedAt = this.#now();
    this.#tryCentral();
  }

  /**
   * Arms the central-mode window timer SYNCHRONOUSLY, before `onEnterCentral()` is even called — not
   * chained behind that call's own promise (found by code review: the previous version armed the timer
   * only inside `.then()`, so a real plugin call that hangs — a scan-until-stopped BLE API with no
   * natural completion, or simply a plugin bug — would silently defeat every bound this class exists to
   * provide: no backoff, no give-up, stuck in "central" forever). The timer below is the one guarantee
   * that does not depend on whether/when the injected callback ever settles — same principle already
   * used in ble-client.js (`HELLO_TIMEOUT_MS` armed independently of the connect/notify calls it bounds).
   */
  #tryCentral() {
    const sessionId = this.#sessionId;
    this.#attempt += 1;
    this.#role = "central";
    this.#timer = this.#setTimeoutFn(() => this.#handleWindowExpired(sessionId), this.#centralWindowMs);
    this.#callEnterCentral();
  }

  /**
   * Everything here runs synchronously, deliberately — `#callEnterPeripheral()`/`#callEnterCentral()`
   * are fire-and-forget (see below), never awaited. Found by code review: an earlier version awaited
   * the return-to-peripheral call before resetting `#attempt`/`#cycleStartedAt` and firing `onGiveUp()`,
   * leaving a window where a `requestSend()` arriving in that gap could start a brand-new cycle that the
   * still-pending give-up would then misreport as abandoned. Keeping every state change in this one
   * synchronous function removes that window entirely — there is no `await` for a `requestSend()` to
   * interleave with.
   */
  #handleWindowExpired(sessionId) {
    if (sessionId !== this.#sessionId) return;
    this.#timer = null;

    const elapsed = this.#now() - this.#cycleStartedAt;
    const budgetExhausted = this.#attempt >= this.#maxAttempts || elapsed >= this.#maxCycleDurationMs;

    this.#role = "peripheral";
    this.#callEnterPeripheral();

    if (budgetExhausted) {
      this.#attempt = 0;
      this.#cycleStartedAt = null;
      this.#onGiveUp();
      return;
    }

    const backoffMs = this.#minBackoffMs + this.#random() * (this.#maxBackoffMs - this.#minBackoffMs);
    this.#timer = this.#setTimeoutFn(() => {
      if (sessionId !== this.#sessionId) return;
      this.#timer = null;
      this.#tryCentral();
    }, backoffMs);
  }

  /**
   * Fire-and-forget: calls an injected plugin callback (`onEnterCentral`/`onEnterPeripheral`) and
   * swallows whatever it does — a synchronous throw, an async rejection, or a promise that never
   * settles at all — without ever awaiting it. Every timing guarantee this class makes (the central
   * window, the backoff, give-up) is armed independently by its callers (`#tryCentral()`/
   * `#handleWindowExpired()`), never gated on this callback actually completing.
   */
  #invoke(callback) {
    try {
      const result = callback();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // best-effort — see this method's own doc comment
    }
  }

  #callEnterCentral() {
    this.#invoke(this.#onEnterCentral);
  }

  #callEnterPeripheral() {
    this.#invoke(this.#onEnterPeripheral);
  }

  #clearTimer() {
    if (this.#timer !== null) {
      this.#clearTimeoutFn(this.#timer);
      this.#timer = null;
    }
  }
}

const AraldBleRoleManager = {
  BleRoleManager,
  DEFAULT_CENTRAL_WINDOW_MS,
  DEFAULT_MIN_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_CYCLE_DURATION_MS,
};

// The one deliberate bridge to the classic, non-module scripts in this directory — see ble-link.js's file header for the same pattern.
if (typeof window !== "undefined") {
  window.AraldBleRoleManager = AraldBleRoleManager;
}
