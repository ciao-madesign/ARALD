import { Identity } from "./identity.js";

/**
 * "Internet come trasporto opzionale tra nodi mesh lontani" (`docs/next-steps.md`) — lo strato che fa
 * parlare direttamente due nodi mesh fisicamente lontani (es. due Box in due rifugi diversi) quando
 * entrambi hanno Internet, senza richiederlo mai come requisito (coerente con `internet-gateway.ts`/
 * `external-delivery.ts`, che seguono già lo stesso principio). Il trasporto TCP esistente funziona già
 * su Internet senza modifiche se un nodo conosce l'indirizzo raggiungibile dell'altro (`NomadNode.connect()`,
 * lo stesso usato da `--connect`) — il pezzo mancante è la scoperta: un piccolo servizio esterno
 * (`discovery-service/`, non in questo workspace npm, auto-ospitabile — nessun servizio di default
 * imposto dal codice) dove un nodo registra il proprio indirizzo e un altro lo cerca per `nodeId`.
 *
 * Questo file è la logica *condivisa* tra chi si registra (`NomadNode`, qui sotto) e chi verifica
 * (`discovery-service/server.ts`) — stesso schema già usato da `content.ts`'s `contentSigningPayload()`/
 * `verifyContentSignature()`: un campo `Signable*Fields`, una funzione di firma con ordine esplicito dei
 * campi, una `verify*()` che riverifica contro la chiave pubblica dichiarata (qui `nodeId` stesso, la
 * chiave pubblica Ed25519 grezza in hex). Un servizio di discovery compromesso o malevolo può rifiutarsi
 * di rispondere o mentire su chi è raggiungibile, ma non può fabbricare una registrazione valida per un
 * `nodeId` che non controlla — **limite esplicito e accettato**: un `nodeId` registra solo che *quel*
 * `nodeId` ha dichiarato quell'indirizzo in quel momento, mai che l'indirizzo sia davvero raggiungibile
 * o che corrisponda a un dispositivo reale e onesto (stesso tipo di limite già accettato per
 * `RelayRegistry`/`EmergencyBeacons` — un'identità mai vista prima è il caso atteso, non un errore).
 *
 * Il modello richiede che un nodo conosca già il proprio indirizzo pubblico raggiungibile (porta
 * inoltrata/IP statico) — **nessun attraversamento NAT automatico in questa prima versione**,
 * esplicitamente fuori scope per `docs/next-steps.md`.
 */

export interface DiscoveryRegistration {
  /** La chiave pubblica Ed25519 grezza in hex — stesso valore di `Identity.nodeId`. */
  nodeId: string;
  /** `host:port` dichiarato dal nodo come proprio indirizzo raggiungibile — mai verificato dal servizio, solo firmato. */
  address: string;
  /**
   * Nome pubblico facoltativo — solo se presente il nodo compare nella rubrica pubblica
   * (`GET /directory`, `discovery-service/server.ts`). Facoltativo e distinto dall'indirizzo: un nodo
   * può registrare il proprio indirizzo per farsi trovare da chi già conosce il suo `nodeId` (rubrica
   * privata) senza comparire nell'elenco pubblico sfogliabile da chiunque.
   */
  label?: string;
  /**
   * Epoch ms al momento della firma — anti-replay (stesso principio già usato da
   * `LocationRegistry.record()`/`RelayRegistry.recordTelemetry()`): il servizio rifiuta una
   * registrazione con un `timestamp` non strettamente più recente dell'ultima accettata per lo stesso
   * `nodeId`, altrimenti chiunque abbia osservato una registrazione passata potrebbe ripresentarla per
   * "congelare" l'indirizzo di un nodo a un valore ormai scaduto.
   */
  timestamp: number;
  /** Firma Ed25519 (hex) di `nodeId`, su `discoverySigningPayload()`. */
  signature: string;
}

export type SignableDiscoveryFields = Pick<DiscoveryRegistration, "nodeId" | "address" | "label" | "timestamp">;

/**
 * Byte canonici firmati da chi si registra — copre `label` oltre a `address`/`timestamp` apposta:
 * firmare solo l'indirizzo lascerebbe un servizio compromesso libero di inventare/cambiare il nome
 * pubblico associato a un `nodeId` genuino, mostrando un'etichetta mai scelta dall'operatore reale.
 */
export function discoverySigningPayload(fields: SignableDiscoveryFields): Buffer {
  return Buffer.from(JSON.stringify({ nodeId: fields.nodeId, address: fields.address, label: fields.label, timestamp: fields.timestamp }));
}

export function signDiscoveryRegistration(identity: Identity, address: string, label: string | undefined, timestamp: number): DiscoveryRegistration {
  const fields: SignableDiscoveryFields = { nodeId: identity.nodeId, address, label, timestamp };
  return { ...fields, signature: identity.sign(discoverySigningPayload(fields)).toString("hex") };
}

/** Riverifica una registrazione contro la chiave pubblica dichiarata (`nodeId` stesso) — mai contro una chiave diversa: un `nodeId` è già, per costruzione, la propria chiave pubblica (`identity.ts`). */
export function verifyDiscoveryRegistration(registration: DiscoveryRegistration): boolean {
  try {
    return Identity.verifyWithNodeId(registration.nodeId, discoverySigningPayload(registration), Buffer.from(registration.signature, "hex"));
  } catch {
    // nodeId/signature malformati, o una chiave che non analizza come Ed25519 — mai fidarsi.
    return false;
  }
}

/** Una voce della rubrica pubblica (`GET /directory`) — mai l'indirizzo reale, solo ciò che serve a un operatore umano per riconoscere un contatto e poi chiedere di connettersi per `nodeId` (`POST /api/discover-peer`, `web-ui.ts`). */
export interface DiscoveryDirectoryEntry {
  nodeId: string;
  label: string;
  /**
   * `true` solo se l'admin di *questo* servizio di discovery ha verificato questa voce
   * (`POST /admin/verify`, `discovery-service/server.ts`) — **mai** un ente certificatore globale:
   * significa solo "chi gestisce questo specifico servizio garantisce per questo nodeId/etichetta",
   * niente di più. L'interfaccia utente deve sempre mostrarlo con questa onestà, mai come una
   * certificazione assoluta.
   */
  verified: boolean;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

async function fetchJsonWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registra/aggiorna l'indirizzo di questo nodo presso il servizio di discovery configurato
 * (`NomadNodeOptions.discoveryServiceUrl`). Lancia su qualunque fallimento (rete, timeout, rifiuto del
 * servizio) — il chiamante (`NomadNode.registerWithDiscoveryService()`) decide come trattarlo (lo stesso
 * "best-effort, nessun retry stretto qui dentro" già applicato a `attemptExternalDeliveryPost()`).
 */
export async function postDiscoveryRegistration(serviceUrl: string, registration: DiscoveryRegistration, timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS): Promise<void> {
  const res = await fetchJsonWithTimeout(
    `${serviceUrl}/register`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(registration) },
    timeoutMs,
  );
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // risposta non-JSON — il codice HTTP resta l'unica informazione disponibile
    }
    throw new Error(`discovery service: registrazione rifiutata — ${message}`);
  }
}

/** Risolve l'indirizzo attualmente registrato per `nodeId`, o `undefined` se il servizio non lo conosce (404) — qualunque altro errore (rete, timeout, 5xx) lancia, mai confuso con "nodo sconosciuto". */
export async function lookupPeerAddress(serviceUrl: string, nodeId: string, timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS): Promise<string | undefined> {
  const res = await fetchJsonWithTimeout(`${serviceUrl}/lookup/${encodeURIComponent(nodeId)}`, {}, timeoutMs);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`discovery service: lookup fallito — HTTP ${res.status}`);
  const body = (await res.json()) as { address?: unknown };
  if (typeof body.address !== "string") throw new Error("discovery service: risposta di lookup malformata");
  return body.address;
}

/**
 * Analizza un indirizzo `"host:port"` o `"[ipv6]:port"` (la stessa forma accettata da
 * `discovery-service/server.ts`'s `ADDRESS_PATTERN`) in `{host, port}`. Un host IPv6 grezzo contiene
 * `:` di suo, quindi uno split naive su `:` tronca silenziosamente l'indirizzo — bug reale trovato
 * dalla revisione in una prima versione di `NomadNode.connectToDiscoveredPeer()`, che usava
 * `address.split(":")` e otteneva `host: "["`/`port: 0` per qualunque indirizzo IPv6 registrato.
 */
export function parseDiscoveryAddress(address: string): { host: string; port: number } {
  if (address.startsWith("[")) {
    const closeIdx = address.indexOf("]:");
    if (closeIdx === -1) throw new Error(`indirizzo IPv6 malformato: "${address}"`);
    return { host: address.slice(1, closeIdx), port: Number(address.slice(closeIdx + 2)) };
  }
  const lastColon = address.lastIndexOf(":");
  if (lastColon === -1) throw new Error(`indirizzo malformato, nessuna porta: "${address}"`);
  return { host: address.slice(0, lastColon), port: Number(address.slice(lastColon + 1)) };
}

/** La rubrica pubblica completa — mai gli indirizzi, solo `{nodeId, label, verified}` per ogni voce che ha scelto di pubblicarsi. */
export async function fetchDiscoveryDirectory(serviceUrl: string, timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS): Promise<DiscoveryDirectoryEntry[]> {
  const res = await fetchJsonWithTimeout(`${serviceUrl}/directory`, {}, timeoutMs);
  if (!res.ok) throw new Error(`discovery service: lettura della rubrica fallita — HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) return [];
  // Mai fidarsi della forma di una risposta di rete più di quanto si farebbe col payload di un
  // pacchetto (CLAUDE.md) — un servizio di discovery compromesso/bacato non deve poter far
  // crashare l'app mobile che consuma questo elenco con una voce malformata.
  return body.filter(
    (entry): entry is DiscoveryDirectoryEntry =>
      entry !== null && typeof entry === "object" && typeof (entry as DiscoveryDirectoryEntry).nodeId === "string" && typeof (entry as DiscoveryDirectoryEntry).label === "string" && typeof (entry as DiscoveryDirectoryEntry).verified === "boolean",
  );
}
