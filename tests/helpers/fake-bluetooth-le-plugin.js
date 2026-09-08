// Fake window.Capacitor.Plugins.BluetoothLe — verifica manuale end-to-end di mobile/www/ble-client.js
// (voce #63, docs/security.md) in un browser reale, senza hardware Bluetooth. Non un test automatico
// permanente: playwright non è (ancora) una devDependency di questo progetto — decisione esplicita
// dell'utente per non appesantire `npm install` con i binari del browser — quindi questo file resta
// un helper riutilizzabile per una futura verifica manuale (o un futuro test automatico, se la
// decisione sulla dipendenza dovesse cambiare), non richiamato da `npx vitest run`.
//
// Un dettaglio architetturale reale che ha guidato il design di questo file: il telefono agisce
// sempre e solo come BLE *centrale* (mai periferica, docs/beacon.md/mobile/README.md) — due centrali
// non possono mai connettersi direttamente tra loro in BLE vero, serve sempre una periferica
// dall'altra parte. Il topology corretto da verificare non è quindi "telefono↔telefono", ma **un solo
// telefono reale (l'app mobile/www/ vera) collegato, come centrale, a più periferiche finte** — che
// è esattamente lo scenario che ble-client.js è pensato per gestire (una Clip, un altro relay). Questo
// file simula quelle periferiche, non un secondo telefono.
//
// Uso, da uno script Node/Playwright (mai eseguito automaticamente):
//   await page.addInitScript({ path: "tests/helpers/fake-bluetooth-le-plugin.js" });
//   // dopo che la pagina ha caricato ble-link.js/ble-relay.js (che popolano window.AraldBleLink/
//   // window.AraldBleRelay, usati qui per costruire/leggere pacchetti col formato reale):
//   await page.evaluate((peripherals) => window.__fakeBle.setup(peripherals), [
//     { deviceId: "clip-a", nodeId: "clip-A" },
//     { deviceId: "clip-b", nodeId: "clip-B" },
//   ]);
//   // simula "clip-a" che invia un pacchetto broadcast (es. un SOS) al telefono:
//   await page.evaluate(
//     ({ deviceId, packet }) => window.__fakeBle.pushFromPeripheral(deviceId, packet),
//     { deviceId: "clip-a", packet: { version: 1, id: "sos-1", type: "CONTENT_ANNOUNCE", source: "clip-A", ttl: 8, timestamp: Date.now(), priority: 0, payload: {} } },
//   );
//   // verifica che "clip-b" l'abbia ricevuto per relay (mai clip-a stesso, mai prima dell'HELLO):
//   const received = await page.evaluate((deviceId) => window.__fakeBle.receivedByPeripheral(deviceId), "clip-b");

(function () {
  const BLE_MTU = 20; // stesso valore di ble-client.js — le periferiche finte devono frammentare/riassemblare con lo stesso MTU per essere fedeli

  /** Un peer BLE finto: risponde a un HELLO in arrivo col proprio, registra ogni pacchetto applicativo ricevuto. */
  function createPeripheral(deviceId, nodeId) {
    return {
      deviceId,
      nodeId,
      connected: false,
      notifyCallback: null, // registrato dal plugin via startNotifications() — come "notificare il telefono"
      reassembler: null, // creato in setup(), dopo che window.AraldBleLink esiste
      helloReceived: false,
      received: [], // pacchetti applicativi (non-HELLO) ricevuti per questa periferica, nell'ordine di arrivo
    };
  }

  let peripherals = new Map(); // deviceId -> peripheral
  let scanCallbacks = [];

  function setup(peripheralDescriptors) {
    peripherals = new Map();
    scanCallbacks = [];
    for (const { deviceId, nodeId, deferDiscovery } of peripheralDescriptors) {
      const peripheral = createPeripheral(deviceId, nodeId);
      peripheral.reassembler = new window.AraldBleLink.FragmentReassembler();
      // Per verificare il percorso "pacchetto unicast in coda -> il peer si connette dopo -> viene
      // consegnato" senza dover aspettare i 30s reali del refresh periodico di ble-client.js: una
      // periferica con deferDiscovery non compare nei risultati di scansione finché
      // announcePeripheral() non viene chiamata esplicitamente dallo script di verifica.
      peripheral.discoverable = !deferDiscovery;
      peripherals.set(deviceId, peripheral);
    }
  }

  /** Fa "comparire" una periferica registrata con deferDiscovery, spingendo subito un risultato di scansione a ogni callback ancora registrato — senza aspettare il refresh periodico reale di ble-client.js. */
  function announcePeripheral(deviceId) {
    const peripheral = peripherals.get(deviceId);
    if (!peripheral) throw new Error(`nessuna periferica finta registrata come ${deviceId}`);
    peripheral.discoverable = true;
    for (const callback of scanCallbacks) callback({ device: { deviceId } });
  }

  /** Invia un frammento (bytes grezzi, non ancora base64) alla periferica come se fosse una notifica GATT in arrivo dal telefono verso di lei — usato sia per l'auto-risposta HELLO sia da pushFromPeripheral(). */
  function notifyDeviceWithPacket(peripheral, packet) {
    if (!peripheral.notifyCallback) return; // il telefono non si è ancora iscritto alle notifiche — pacchetto perso, stesso comportamento di un vero link non ancora pronto
    const fragments = window.AraldBleLink.fragmentPacket(packet, BLE_MTU);
    for (const fragment of fragments) {
      // Asincrono (setTimeout, non sincrono) — un vero evento BLE non arriverebbe mai nello stesso tick della chiamata che l'ha originato.
      setTimeout(() => peripheral.notifyCallback({ value: window.AraldBleLink.bytesToBase64(fragment) }), 0);
    }
  }

  /** Chiamata dallo script di verifica per simulare "questa periferica invia un pacchetto applicativo (es. un SOS) al telefono" — solo dopo l'handshake, come farebbe un vero peer già connesso e identificato. */
  function pushFromPeripheral(deviceId, packet) {
    const peripheral = peripherals.get(deviceId);
    if (!peripheral) throw new Error(`nessuna periferica finta registrata come ${deviceId}`);
    notifyDeviceWithPacket(peripheral, packet);
  }

  function receivedByPeripheral(deviceId) {
    const peripheral = peripherals.get(deviceId);
    return peripheral ? peripheral.received.map((p) => p.id) : [];
  }

  function isConnected(deviceId) {
    const peripheral = peripherals.get(deviceId);
    return Boolean(peripheral && peripheral.connected);
  }

  window.__fakeBle = { setup, announcePeripheral, pushFromPeripheral, receivedByPeripheral, isConnected };

  window.Capacitor = window.Capacitor || {};
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};
  window.Capacitor.Plugins.BluetoothLe = {
    async initialize() {},

    async requestLEScan(_options, callback) {
      scanCallbacks.push(callback);
      // Ogni periferica non ancora connessa "si fa scoprire" poco dopo l'avvio della scansione —
      // asincrono, come un vero risultato di scansione arriverebbe dopo un intervallo di advertising.
      // Una periferica con discoverable=false (deferDiscovery in setup()) resta invisibile finché
      // announcePeripheral() non viene chiamata esplicitamente.
      for (const peripheral of peripherals.values()) {
        if (peripheral.connected || !peripheral.discoverable) continue;
        setTimeout(() => {
          if (!scanCallbacks.includes(callback)) return; // scansione già fermata nel frattempo
          callback({ device: { deviceId: peripheral.deviceId } });
        }, 20);
      }
    },

    async stopLEScan() {
      scanCallbacks = [];
    },

    async connect(options, _disconnectCallback) {
      const peripheral = peripherals.get(options.deviceId);
      if (!peripheral) throw new Error(`nessuna periferica finta registrata come ${options.deviceId}`);
      peripheral.connected = true;
      // disconnectCallback non richiamato qui — questo fake non simula disconnessioni inaspettate,
      // solo il percorso "felice" del multi-hop relay che questa verifica vuole dimostrare.
    },

    async startNotifications(options, callback) {
      const peripheral = peripherals.get(options.deviceId);
      if (!peripheral) throw new Error(`nessuna periferica finta registrata come ${options.deviceId}`);
      peripheral.notifyCallback = callback;
    },

    async stopNotifications(options) {
      const peripheral = peripherals.get(options.deviceId);
      if (peripheral) peripheral.notifyCallback = null;
    },

    async write(options) {
      const peripheral = peripherals.get(options.deviceId);
      if (!peripheral) throw new Error(`nessuna periferica finta registrata come ${options.deviceId}`);
      const bytes = window.AraldBleLink.base64ToBytes(options.value);
      const reassembled = peripheral.reassembler.addFragment(bytes);
      if (!reassembled) return; // frammento parziale, nulla da fare ancora
      const packet = window.AraldBleLink.decodePacket(reassembled);
      if (packet.type === "HELLO") {
        if (peripheral.helloReceived) return; // già risposto una volta, non ripetere
        peripheral.helloReceived = true;
        // Auto-risposta: una vera periferica risponderebbe col proprio HELLO non appena riconosce
        // quello del telefono — stesso ordine "indipendente, mai gated" già richiesto a
        // connectToPeer() lato ble-client.js.
        notifyDeviceWithPacket(peripheral, {
          version: 1,
          id: `hello-from-${peripheral.deviceId}`,
          type: "HELLO",
          source: peripheral.nodeId,
          ttl: 1,
          timestamp: Date.now(),
          priority: 2,
          payload: {},
        });
        return;
      }
      peripheral.received.push(packet);
    },

    async disconnect(options) {
      const peripheral = peripherals.get(options.deviceId);
      if (peripheral) peripheral.connected = false;
    },
  };
})();
