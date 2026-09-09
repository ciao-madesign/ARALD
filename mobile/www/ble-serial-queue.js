// A minimal async task queue that runs its tasks one at a time, in submission order — used by
// mobile/www/ble-dual-role-client.js to work around a real, verified limitation of
// @capgo/capacitor-bluetooth-low-energy@8.2.0 (see that file's own header for the full story): its
// native side tracks `connect()`/`writeCharacteristic()`/`startCharacteristicNotifications()`/
// `readCharacteristic()` each behind a SINGLE shared "pending call" field, not one per device —
// found by reading the actual Android source (`BluetoothLowEnergyPlugin.java`, downloaded via
// `npm pack` since the plugin's own website/GitHub were unreachable from this environment). Two
// calls of the *same* method in flight at once (e.g. two concurrent `connect()`s to different
// peers, exactly what this project's relay does when several devices are discovered together) can
// resolve each other's promise instead of their own. Serializing same-type calls through one queue
// removes the race entirely, at the cost of some throughput — an acceptable trade for small,
// occasional relay traffic, not a high-bandwidth link.
//
// Written as a real ES module (see ble-link.js's own file header for why), pure and independent of
// any plugin — fully unit-testable, unlike the plugin-calling code around it (see
// ble-dual-role-client.js's own header for what is/isn't verified there).

/**
 * Runs `taskFn` after every previously-queued task on this queue has settled (resolved or
 * rejected) — never concurrently with another task on the same queue. Each `run()` call gets its
 * own promise, resolving/rejecting with `taskFn`'s own outcome; a failing task never blocks the
 * tasks queued after it (the internal chain always continues, via the `.catch(() => {})` below).
 */
export class SerialQueue {
  #tail = Promise.resolve();

  run(taskFn) {
    const result = this.#tail.then(() => taskFn());
    // The queue's own internal chain must never reject — otherwise every task queued after a
    // failing one would silently never run (a rejected promise short-circuits every subsequent
    // `.then()` in the chain). The caller's own `result` promise above is a *separate* promise
    // object, so it still faithfully rejects with `taskFn`'s real error — only the internal
    // bookkeeping chain is shielded here.
    this.#tail = result.catch(() => {});
    return result;
  }
}

const AraldBleSerialQueue = { SerialQueue };

// The one deliberate bridge to the classic, non-module scripts in this directory — see ble-link.js's file header for the same pattern.
if (typeof window !== "undefined") {
  window.AraldBleSerialQueue = AraldBleSerialQueue;
}
