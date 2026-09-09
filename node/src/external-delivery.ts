import { createHash, timingSafeEqual } from "node:crypto";
import { BoundedFifoMap } from "./bounded-map.js";
import { EncryptionIdentity, encryptForPeer, decryptFromPeer, type EncryptedPayload } from "./encryption.js";
import { Priority, priorityRank } from "./packet.js";
import { isPubliclyRoutableUrl } from "./url-safety.js";

/**
 * Consegna esterna differita (`docs/service-catalog.md`, `docs/next-steps.md`)
 * — un operatore invia un file attraverso la mesh verso un nodo (tipicamente
 * un ARALD Box/Portable) che ha *anche* accesso Internet reale; quel nodo lo
 * tiene in coda finché Internet non torna disponibile, poi lo consegna verso
 * una destinazione esterna (server di un'organizzazione) — E2E cifrato fino
 * a quella destinazione, mai leggibile dal nodo che lo tiene in coda.
 *
 * Requisito guida (discusso con l'utente, `docs/service-catalog.md`):
 * l'operatore sceglie una **destinazione da un'etichetta amichevole**
 * ("Headquarter"), mai un URL/indirizzo tecnico — quella corrispondenza è
 * responsabilità esclusiva dell'admin del nodo che offre questo ruolo
 * ("il BOX" nel resto di questo file, anche se nulla qui lo richiede
 * letteralmente — qualunque `NomadNode` può offrire il ruolo).
 *
 * **Due directory distinte, mai confuse fra loro**:
 * - `ExternalDeliveryAllowlist` — **privata**, vive solo nella configurazione
 *   del BOX (`node/src/cli.ts`'s `--external-delivery-destinations`), non
 *   lascia mai quel processo: contiene l'URL di consegna reale e, se
 *   presente, la password che protegge la destinazione.
 * - `ExternalDeliveryDirectory` — **pubblica**, pubblicata dal BOX come
 *   `content://` (`EXTERNAL_DELIVERY_DIRECTORY_CONTENT_NAME`), si propaga
 *   mesh-wide tramite la sincronizzazione dei cataloghi già esistente
 *   (`catalog.ts`) — contiene solo `{destinationId, label, publicKeyHex,
 *   requiresPassword}`, **mai** l'URL né la password: è quello che un
 *   dispositivo lontano dal BOX (mai stato in contatto diretto con esso) usa
 *   per popolare un menu a tendina senza dover conoscere nulla di tecnico.
 */

// ---------------------------------------------------------------------------
// Cifratura E2E fino alla destinazione — wrapper sottili su encryption.ts,
// nessuna nuova primitiva crittografica.
// ---------------------------------------------------------------------------

export interface ExternalDeliverySealedPayload extends EncryptedPayload {
  /**
   * Chiave pubblica X25519 (hex) di una coppia **effimera, generata ad-hoc
   * per questo singolo invio** — mai l'identità di cifratura mesh a lungo
   * periodo del mittente (`NomadNode.encryptionIdentity`). Motivo: la
   * destinazione è esterna alla mesh; un'organizzazione che ricevesse più
   * invii nel tempo non deve poter correlarli alla stessa identità mesh
   * tramite la chiave. Necessaria alla destinazione per calcolare la stessa
   * chiave condivisa (ECDH è simmetrica, `EncryptionIdentity.sharedKeyWith()`).
   */
  senderEphemeralPublicKey: string;
}

/**
 * Cifra `plaintext` per `destinationPublicKeyHex` — genera una coppia X25519
 * usa-e-getta, deriva la chiave condivisa (`EncryptionIdentity.sharedKeyWith()`,
 * ECDH), cifra con AES-256-GCM (`encryptForPeer()`, già esistente). Il BOX
 * che inoltrerà il risultato non vede mai `plaintext` né potrebbe mai
 * derivare la stessa chiave condivisa (non possiede né la chiave privata
 * effimera del mittente né quella statica della destinazione).
 */
export function sealExternalDelivery(destinationPublicKeyHex: string, plaintext: Buffer): ExternalDeliverySealedPayload {
  const ephemeral = EncryptionIdentity.generate();
  const sharedKey = ephemeral.sharedKeyWith(destinationPublicKeyHex);
  const encrypted = encryptForPeer(sharedKey, plaintext);
  return { senderEphemeralPublicKey: ephemeral.publicKeyHex, ...encrypted };
}

/**
 * Il lato "destinazione" della stessa cifratura — usata dai test di questo
 * pezzo per verificare che il BOX non possa mai decifrare (non ha la chiave
 * privata usata qui) e che solo chi possiede `destinationIdentity` ci
 * riesca. Documenta anche, per riferimento, lo schema esatto che
 * un'organizzazione esterna reale dovrebbe re-implementare nel proprio
 * sistema (X25519 statico-effimero + AES-256-GCM, `sharedKeyWith()`'s stessa
 * derivazione SHA-256) — quel codice non vive in questo repository, la
 * destinazione è per definizione esterna alla mesh.
 */
export function unsealExternalDelivery(destinationIdentity: EncryptionIdentity, sealed: ExternalDeliverySealedPayload): Buffer {
  const sharedKey = destinationIdentity.sharedKeyWith(sealed.senderEphemeralPublicKey);
  return decryptFromPeer(sharedKey, { nonce: sealed.nonce, ciphertext: sealed.ciphertext, authTag: sealed.authTag });
}

// ---------------------------------------------------------------------------
// Autorizzazione per-destinazione — password semplice condivisa, mai
// trasmessa in chiaro sulla mesh (docs/service-catalog.md).
// ---------------------------------------------------------------------------

/**
 * `sha256(password + ":" + destinationId + ":" + nonce + ":" + ciphertext + ":" + authTag)` —
 * bound to the *specific sealed submission*, not just to (password, destinationId) alone (found by
 * code-review: an earlier version hashed only password+destinationId, which meant anyone who observed
 * one valid `authProof` in the clear — every mesh relay on the path, by design, since only the
 * ciphertext itself is opaque — could forge unlimited new `EXTERNAL_DELIVERY` packets with the same
 * proof but attacker-chosen `nonce`/`ciphertext`/`authTag` toward the same destination; the BOX never
 * decrypts, so it had no way to tell a forged submission from a real one, and would happily queue and
 * eventually POST attacker-controlled garbage to the organization's real intake endpoint under the
 * guise of an authenticated submission). Binding the proof to the sealed fields themselves closes
 * that: a captured proof only ever validates for the exact bytes it was computed over.
 *
 * Still deterministic, still no session/nonce of its own (limite accettato dichiarato esplicitamente,
 * `docs/security.md`) — a relay that replays the *entire* captured packet verbatim (identical
 * `nonce`/`ciphertext`/`authTag`/`authProof`, only a fresh `packet.id`) still produces only a
 * duplicate of the exact same submission, never a forgery of different content, which is the
 * limitation this was always meant to describe. Calcolata lato gateway del mittente, mai sul
 * telefono: la password vera non lascia mai quel singolo hop già fidato.
 */
export function computeExternalDeliveryAuthProof(password: string, destinationId: string, nonce: string, ciphertext: string, authTag: string): string {
  return createHash("sha256").update(`${password}:${destinationId}:${nonce}:${ciphertext}:${authTag}`).digest("hex");
}

/** `true` se la destinazione non richiede password (`configuredPassword` assente) oppure se `providedProofHex` combacia contro la stessa tupla (password, destinationId, nonce, ciphertext, authTag) — confronto a tempo costante, stessa disciplina già usata per la password di rete in `web-ui.ts`. */
export function verifyExternalDeliveryAuthProof(
  providedProofHex: string | undefined,
  configuredPassword: string | undefined,
  destinationId: string,
  nonce: string,
  ciphertext: string,
  authTag: string,
): boolean {
  if (!configuredPassword) return true;
  if (!providedProofHex) return false;
  const expectedHex = computeExternalDeliveryAuthProof(configuredPassword, destinationId, nonce, ciphertext, authTag);
  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(providedProofHex, "hex");
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Payload del pacchetto mesh (MessageType.EXTERNAL_DELIVERY) — mai fidarsi
// della forma del payload più del tipo dichiarato (CLAUDE.md).
// ---------------------------------------------------------------------------

export const MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH = 100;
const X25519_PUBLIC_KEY_HEX_LENGTH = 64; // 32 byte
const AES_GCM_NONCE_HEX_LENGTH = 24; // 12 byte
const AES_GCM_AUTH_TAG_HEX_LENGTH = 32; // 16 byte
const SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-f]+$/i;

export interface ExternalDeliveryPayload {
  /** In chiaro — verificato contro l'allowlist privata del destinatario, mai contro un segreto. */
  destinationId: string;
  senderEphemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  /** Presente solo se la destinazione scelta richiede una password (`verifyExternalDeliveryAuthProof()`). */
  authProof?: string;
  submittedAt: number;
}

/**
 * Valida difensivamente un `ExternalDeliveryPayload` grezzo, incluso il tetto
 * sulla dimensione del ciphertext (`maxCiphertextHexLength`, derivato da
 * `NomadNodeOptions.maxExternalDeliveryPayloadBytes` — hex raddoppia i byte
 * grezzi) — un invio oltre il limite viene scartato qui, mai accodato.
 * `undefined` per qualunque forma non esattamente valida, stessa postura di
 * `extractDropPayload()`/`extractNodeAppendPayload()`.
 */
export function extractExternalDeliveryPayload(payload: unknown, maxCiphertextHexLength: number): ExternalDeliveryPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.destinationId !== "string" || p.destinationId.length === 0 || p.destinationId.length > MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH) {
    return undefined;
  }
  if (typeof p.senderEphemeralPublicKey !== "string" || p.senderEphemeralPublicKey.length !== X25519_PUBLIC_KEY_HEX_LENGTH || !HEX_PATTERN.test(p.senderEphemeralPublicKey)) {
    return undefined;
  }
  if (typeof p.nonce !== "string" || p.nonce.length !== AES_GCM_NONCE_HEX_LENGTH || !HEX_PATTERN.test(p.nonce)) return undefined;
  if (typeof p.ciphertext !== "string" || p.ciphertext.length > maxCiphertextHexLength || (p.ciphertext.length > 0 && !HEX_PATTERN.test(p.ciphertext))) {
    return undefined;
  }
  if (typeof p.authTag !== "string" || p.authTag.length !== AES_GCM_AUTH_TAG_HEX_LENGTH || !HEX_PATTERN.test(p.authTag)) return undefined;
  let authProof: string | undefined;
  if (p.authProof !== undefined) {
    if (typeof p.authProof !== "string" || p.authProof.length !== SHA256_HEX_LENGTH || !HEX_PATTERN.test(p.authProof)) return undefined;
    authProof = p.authProof;
  }
  if (typeof p.submittedAt !== "number" || !Number.isFinite(p.submittedAt)) return undefined;
  return {
    destinationId: p.destinationId,
    senderEphemeralPublicKey: p.senderEphemeralPublicKey,
    nonce: p.nonce,
    ciphertext: p.ciphertext,
    authTag: p.authTag,
    authProof,
    submittedAt: p.submittedAt,
  };
}

// ---------------------------------------------------------------------------
// Directory pubblica (content://) — solo etichette/chiavi pubbliche/booleano,
// mai l'URL reale né la password.
// ---------------------------------------------------------------------------

/** Nome fisso di `ContentMetadata.name` sotto cui un BOX pubblica la propria directory — stessa convenzione a nome fisso di `DROP_CONTENT_NAME` (`drops.ts`). */
export const EXTERNAL_DELIVERY_DIRECTORY_CONTENT_NAME = "external-delivery-directory";

export const MAX_EXTERNAL_DELIVERY_LABEL_LENGTH = 100;
const MAX_EXTERNAL_DELIVERY_DESTINATIONS_PER_DIRECTORY = 50;

export interface ExternalDeliveryDirectoryEntry {
  destinationId: string;
  label: string;
  publicKeyHex: string;
  /** Mai la password stessa né un suo hash — solo "questa destinazione ne richiede una", cosa basta al client per decidere se mostrare il campo password. */
  requiresPassword: boolean;
}

export interface ExternalDeliveryDirectoryPayload {
  destinations: ExternalDeliveryDirectoryEntry[];
  /** Dentro i byte firmati (come `DropPayload.timestamp`), mai ri-derivato da `ContentMetadata` — usato da `ExternalDeliveryDirectory.record()` per non lasciare che una ri-sincronizzazione fuori ordine sovrascriva una pubblicazione più recente con una più vecchia dello stesso publisher. */
  createdAt: number;
}

export function extractExternalDeliveryDirectoryPayload(payload: unknown): ExternalDeliveryDirectoryPayload | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.createdAt !== "number" || !Number.isFinite(p.createdAt)) return undefined;
  if (!Array.isArray(p.destinations) || p.destinations.length > MAX_EXTERNAL_DELIVERY_DESTINATIONS_PER_DIRECTORY) return undefined;
  const destinations: ExternalDeliveryDirectoryEntry[] = [];
  for (const raw of p.destinations) {
    if (!raw || typeof raw !== "object") return undefined;
    const d = raw as Record<string, unknown>;
    if (typeof d.destinationId !== "string" || d.destinationId.length === 0 || d.destinationId.length > MAX_EXTERNAL_DELIVERY_DESTINATION_ID_LENGTH) {
      return undefined;
    }
    if (typeof d.label !== "string" || d.label.length === 0 || d.label.length > MAX_EXTERNAL_DELIVERY_LABEL_LENGTH) return undefined;
    if (typeof d.publicKeyHex !== "string" || d.publicKeyHex.length !== X25519_PUBLIC_KEY_HEX_LENGTH || !HEX_PATTERN.test(d.publicKeyHex)) {
      return undefined;
    }
    if (typeof d.requiresPassword !== "boolean") return undefined;
    destinations.push({ destinationId: d.destinationId, label: d.label, publicKeyHex: d.publicKeyHex, requiresPassword: d.requiresPassword });
  }
  return { destinations, createdAt: p.createdAt };
}

export interface ExternalDeliveryDirectoryOptions {
  /** Quanti BOX/publisher distinti tracciare contemporaneamente (spec §57 resource limits). */
  maxPublishers?: number;
}

const DEFAULT_MAX_DIRECTORY_PUBLISHERS = 256;

/**
 * Vista locale, aggregata su più publisher, delle directory pubbliche
 * apprese dalla mesh — stesso posizionamento architetturale di `Drops`/
 * `PublicChannels`: stato derivato interamente da `content://` già
 * verificato, mai una struttura firmata/propagata a sé.
 */
export class ExternalDeliveryDirectory {
  private readonly byPublisher: BoundedFifoMap<string, ExternalDeliveryDirectoryPayload>;

  constructor(options: ExternalDeliveryDirectoryOptions = {}) {
    this.byPublisher = new BoundedFifoMap({ maxSize: options.maxPublishers ?? DEFAULT_MAX_DIRECTORY_PUBLISHERS });
  }

  record(publisherId: string, payload: ExternalDeliveryDirectoryPayload): void {
    const existing = this.byPublisher.get(publisherId);
    if (existing && existing.createdAt >= payload.createdAt) return;
    this.byPublisher.set(publisherId, payload);
  }

  /** Elenco appiattito per `GET /api/external-delivery-destinations` — ogni voce porta con sé il node id del BOX che l'ha pubblicata (`ContentMetadata.publisherId`), così il client non deve mai scoprirlo separatamente. */
  list(): Array<ExternalDeliveryDirectoryEntry & { boxNodeId: string }> {
    const result: Array<ExternalDeliveryDirectoryEntry & { boxNodeId: string }> = [];
    for (const [publisherId, payload] of this.byPublisher) {
      for (const destination of payload.destinations) {
        result.push({ ...destination, boxNodeId: publisherId });
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Allowlist privata del BOX — mai propagata, mai firmata/pubblicata così
// com'è (solo una sua proiezione senza url/password diventa la directory
// pubblica sopra).
// ---------------------------------------------------------------------------

export interface ExternalDeliveryDestination {
  destinationId: string;
  label: string;
  publicKeyHex: string;
  url: string;
  /** Se presente, un invio verso questa destinazione deve portare un `authProof` valido (`verifyExternalDeliveryAuthProof()`). */
  password?: string;
}

export type ExternalDeliveryAllowlist = Map<string, ExternalDeliveryDestination>;

// ---------------------------------------------------------------------------
// Coda locale sul BOX — genuinamente diversa da PendingDeliveryQueue
// (store-and-forward.ts): quella aspetta il prossimo hop mesh, questa
// aspetta che torni Internet. Bounded su due assi (conteggio *e* byte
// totali — le entry qui variano molto in dimensione, a differenza di un
// pacchetto ordinario), quindi non riusa BoundedFifoMap direttamente (il
// suo singolo scalare di eviction non basta) — mirror del suo stesso
// principio (priority-weighted, mai plain FIFO), non della sua implementazione.
// ---------------------------------------------------------------------------

export interface QueuedExternalDelivery {
  packetId: string;
  destinationId: string;
  url: string;
  senderEphemeralPublicKey: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
  submittedAt: number;
  priority: Priority;
  sizeBytes: number;
  expiresAt: number;
}

export interface ExternalDeliveryQueueOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
}

const DEFAULT_MAX_QUEUE_ENTRIES = 100;
const DEFAULT_MAX_QUEUE_TOTAL_BYTES = 50_000_000; // 50 MB — punto di partenza conservativo, da tarare sulle specifiche hardware reali del BOX (docs/service-catalog.md)
const DEFAULT_QUEUE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export class ExternalDeliveryQueue {
  private readonly entries = new Map<string, QueuedExternalDelivery>();
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private totalBytes = 0;

  constructor(options: ExternalDeliveryQueueOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_QUEUE_ENTRIES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_QUEUE_TOTAL_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_QUEUE_TTL_MS;
  }

  has(packetId: string): boolean {
    return this.entries.has(packetId);
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytesUsed(): number {
    return this.totalBytes;
  }

  /** No-op se `packetId` è già in coda (stesso dedup di `PendingDeliveryQueue.enqueue()`). Accetta sempre la nuova entry, sfrattando entry esistenti se necessario per restare sotto i due tetti — un invio appena arrivato non viene mai rifiutato a priori, stessa filosofia "accodabile sempre" di `PendingDeliveryQueue`. */
  enqueue(entry: Omit<QueuedExternalDelivery, "expiresAt" | "priority"> & { priority: unknown }): void {
    if (this.entries.has(entry.packetId)) return;
    const clampedPriority = priorityRank(entry.priority);
    this.entries.set(entry.packetId, { ...entry, priority: clampedPriority, expiresAt: Date.now() + this.ttlMs });
    this.totalBytes += entry.sizeBytes;
    this.evictWhileOverCapacity();
  }

  private evictWhileOverCapacity(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxTotalBytes) {
      const victim = this.pickLowestPriorityOldest();
      if (victim === undefined) break; // niente altro da sfrattare (solo se i tetti sono impostati a 0)
      const entry = this.entries.get(victim);
      this.entries.delete(victim);
      if (entry) this.totalBytes -= entry.sizeBytes;
    }
  }

  /** Punteggio più alto = meno urgente (`Priority.BULK` batte `Priority.EMERGENCY`) — la prima entry con lo score peggiore incontrata vince, e `Map` preserva l'ordine di inserimento, quindi a parità di priorità è sempre la più vecchia a essere scelta, stesso comportamento di `BoundedFifoMap`'s la propria eviction FIFO. */
  private pickLowestPriorityOldest(): string | undefined {
    let bestKey: string | undefined;
    let worstRank = -1;
    for (const [key, entry] of this.entries) {
      const rank = priorityRank(entry.priority);
      if (rank > worstRank) {
        worstRank = rank;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /** Le entry ancora valide su cui vale la pena tentare una consegna adesso — scartando in silenzio (senza restituirle) quelle scadute incontrate lungo la strada, stesso "pulisci mentre attraversi" di `Drops.list()`. Non rimuove le entry restituite: resta compito del chiamante chiamare `remove()` solo dopo una consegna riuscita — un tentativo fallito le lascia in coda per il prossimo giro. */
  entriesDueForAttempt(): QueuedExternalDelivery[] {
    const now = Date.now();
    const ready: QueuedExternalDelivery[] = [];
    for (const [packetId, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(packetId);
        this.totalBytes -= entry.sizeBytes;
        continue;
      }
      ready.push(entry);
    }
    return ready;
  }

  /** Chiamata dopo una consegna riuscita (risposta HTTP 2xx dalla destinazione) — no-op se `packetId` non è (più) in coda. */
  remove(packetId: string): void {
    const entry = this.entries.get(packetId);
    if (!entry) return;
    this.entries.delete(packetId);
    this.totalBytes -= entry.sizeBytes;
  }
}

// ---------------------------------------------------------------------------
// Consegna verso l'esterno — un vero componente di rete in uscita, nuovo.
// ---------------------------------------------------------------------------

const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Tenta una singola consegna HTTP verso `entry.url` — corpo JSON opaco al
 * chiamante quanto lo è al BOX (`{destinationId, senderEphemeralPublicKey,
 * nonce, ciphertext, authTag, submittedAt}`). `true` solo su una risposta
 * 2xx — qualunque altro esito (rete assente, timeout, 4xx/5xx) ritorna
 * `false` senza lanciare: il chiamante (`NomadNode.attemptExternalDeliveries()`)
 * lascia semplicemente l'entry in coda per il prossimo giro, "best-effort,
 * nessun ack" (decisione esplicita dell'utente) — mai un retry immediato in
 * loop stretto qui dentro.
 */
export async function attemptExternalDeliveryPost(entry: QueuedExternalDelivery, timeoutMs: number = DEFAULT_DELIVERY_TIMEOUT_MS): Promise<boolean> {
  // Difesa in profondità (CLAUDE.md) contro un errore di configurazione dell'admin (es. un URL
  // interno incollato per sbaglio nel file destinations.json) — stessa guardia SSRF già usata in
  // ingresso da gateway/nomad/internet-gateway.ts, qui riusata in uscita. Ricontrollata ad ogni
  // tentativo (non solo all'avvio) perché l'URL vive in un file che può cambiare tra un riavvio e
  // l'altro senza che questo modulo lo sappia in anticipo.
  let url: URL;
  try {
    url = new URL(entry.url);
  } catch {
    return false;
  }
  if (!(await isPubliclyRoutableUrl(url))) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(entry.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destinationId: entry.destinationId,
        senderEphemeralPublicKey: entry.senderEphemeralPublicKey,
        nonce: entry.nonce,
        ciphertext: entry.ciphertext,
        authTag: entry.authTag,
        submittedAt: entry.submittedAt,
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
