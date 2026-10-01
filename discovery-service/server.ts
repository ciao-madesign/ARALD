import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { BoundedFifoMap } from "../node/src/bounded-map.js";
import { BodyTooLargeError, LoopbackHttpServer, readRequestBody, sendJson } from "../node/src/loopback-http-server.js";
import { verifyDiscoveryRegistration, type DiscoveryDirectoryEntry, type DiscoveryRegistration } from "../node/src/discovery-client.js";

/**
 * "Internet come trasporto opzionale tra nodi mesh lontani" (`docs/next-steps.md`) — il servizio di
 * discovery, un "elenco telefonico" condiviso dove un nodo con Internet registra il proprio indirizzo
 * raggiungibile. Deliberatamente **fuori dalla mesh**, come `whatsapp-relay/`/`email-relay/`: un operatore
 * (o una comunità di operatori) lo avvia dove preferisce — **nessun indirizzo di default imposto da questo
 * codice**, coerente con "Internet arricchisce, mai un requisito" già seguito ovunque in questo progetto.
 *
 * Due livelli di fiducia distinti, mai confusi:
 * 1. **Firma Ed25519** (`node/src/discovery-client.ts`): garantisce solo che una registrazione provenga
 *    davvero da chi controlla quel `nodeId` — mai che l'indirizzo dichiarato sia reale/raggiungibile, né
 *    che dietro quel `nodeId` ci sia davvero l'ente che il suo `label` pubblico afferma di essere.
 * 2. **Verifica dell'admin** (`verified`, sotto): chi gestisce *questo* servizio può marcare una voce
 *    pubblica come verificata dopo un proprio controllo fuori banda (una telefonata, un documento — un
 *    processo reale/umano, mai automatizzato da questo codice). Significa solo "chi gestisce questo
 *    specifico servizio garantisce per questa voce", **mai** un ente certificatore globale — l'app mobile
 *    deve sempre mostrarlo con questa onestà esplicita.
 */

const ADDRESS_PATTERN = /^[a-zA-Z0-9.\-:[\]]+:\d{1,5}$/; // "host:port" o "[ipv6]:port" — solo una forma plausibile, mai una vera verifica di raggiungibilità
const MAX_LABEL_LENGTH = 100;
const MAX_BODY_BYTES = 8192;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REGISTRATIONS = 10_000;

interface StoredRegistration extends DiscoveryRegistration {
  verified: boolean;
  verifiedAt?: number;
}

export interface DiscoveryServiceOptions {
  port?: number;
  host?: string;
  /** Password richiesta (header `Authorization: Bearer <password>`) per `POST /admin/verify`. Se omessa, quell'endpoint resta sempre inaccessibile (404) — stesso schema "nessuna password, nessuna scrittura privilegiata" già usato da `web-ui.ts`. */
  adminPassword?: string;
  /** Tetto sul numero di `nodeId` distinti registrati contemporaneamente (spec §57 resource limits, stesso principio applicato qui a un servizio esterno alla mesh) — un `nodeId` usa-e-getta rotante non deve poter far crescere questo elenco senza limite. */
  maxRegistrations?: number;
}

export class DiscoveryService {
  private readonly httpServer: LoopbackHttpServer;
  private readonly adminPassword: string | undefined;
  private readonly registrations: BoundedFifoMap<string, StoredRegistration>;

  constructor(options: DiscoveryServiceOptions = {}) {
    this.adminPassword = options.adminPassword;
    this.registrations = new BoundedFifoMap({ maxSize: options.maxRegistrations ?? DEFAULT_MAX_REGISTRATIONS });
    this.httpServer = new LoopbackHttpServer((req, res) => void this.route(req, res), { port: options.port, host: options.host });
  }

  get port(): number {
    return this.httpServer.port;
  }

  async start(): Promise<void> {
    await this.httpServer.start();
  }

  async stop(): Promise<void> {
    await this.httpServer.stop();
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/register") {
      await this.handleRegister(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/lookup/")) {
      this.handleLookup(res, decodeURIComponent(url.pathname.slice("/lookup/".length)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/directory") {
      this.handleDirectory(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/verify") {
      await this.handleAdminVerify(req, res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  /**
   * Un nodo si registra/aggiorna il proprio indirizzo. Rifiuta: corpo malformato, firma non valida
   * (mai fidarsi di una registrazione non firmata da chi dichiara di esserne l'autore — stessa
   * disciplina di `verifyContentSignature()`), un `timestamp` non strettamente più recente dell'ultima
   * registrazione accettata per lo stesso `nodeId` (anti-replay, stesso principio di
   * `LocationRegistry.record()`).
   *
   * **`label` che cambia rispetto a una voce già verificata azzera `verified`** (decisione esplicita,
   * trovata necessaria progettando questa voce): la spunta certifica che *quell'etichetta* appartiene
   * davvero a quel `nodeId` — lasciarla sopravvivere a un cambio di etichetta permetterebbe a un'entità
   * verificata di rinominarsi silenziosamente in qualcos'altro mantenendo la spunta di un nome mai
   * controllato dall'admin.
   */
  private async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof BodyTooLargeError) sendJson(res, 413, { error: "request body too large" });
      else sendJson(res, 400, { error: "failed to read request body" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }

    const body = parsed as Partial<DiscoveryRegistration> | null;
    if (!body || typeof body.nodeId !== "string" || body.nodeId.length === 0) {
      sendJson(res, 400, { error: "'nodeId' must be a non-empty string" });
      return;
    }
    if (typeof body.address !== "string" || !ADDRESS_PATTERN.test(body.address)) {
      sendJson(res, 400, { error: "'address' must be a 'host:port' string" });
      return;
    }
    if (body.label !== undefined && (typeof body.label !== "string" || body.label.length === 0 || body.label.length > MAX_LABEL_LENGTH)) {
      sendJson(res, 400, { error: `'label' must be a string of 1-${MAX_LABEL_LENGTH} characters` });
      return;
    }
    if (typeof body.timestamp !== "number" || !Number.isFinite(body.timestamp)) {
      sendJson(res, 400, { error: "'timestamp' must be a finite number" });
      return;
    }
    if (typeof body.signature !== "string" || body.signature.length === 0) {
      sendJson(res, 400, { error: "'signature' must be a non-empty string" });
      return;
    }
    const registration: DiscoveryRegistration = { nodeId: body.nodeId, address: body.address, label: body.label, timestamp: body.timestamp, signature: body.signature };
    if (!verifyDiscoveryRegistration(registration)) {
      sendJson(res, 401, { error: "invalid signature" });
      return;
    }

    const existing = this.registrations.get(registration.nodeId);
    if (existing && existing.timestamp >= registration.timestamp) {
      sendJson(res, 409, { error: "timestamp is not newer than the last accepted registration for this nodeId" });
      return;
    }

    const labelChanged = existing?.label !== registration.label;
    this.registrations.set(registration.nodeId, {
      ...registration,
      verified: existing !== undefined && existing.verified && !labelChanged,
      verifiedAt: existing !== undefined && existing.verified && !labelChanged ? existing.verifiedAt : undefined,
    });
    sendJson(res, 200, { ok: true });
  }

  /** `GET /lookup/:nodeId` — l'indirizzo attualmente registrato per `nodeId`, o 404 se non noto. Mai l'intera registrazione (firma/timestamp sono dettagli interni di questo servizio, non utili a chi vuole solo connettersi). */
  private handleLookup(res: ServerResponse, nodeId: string): void {
    const entry = this.registrations.get(nodeId);
    if (!entry) {
      sendJson(res, 404, { error: "unknown nodeId" });
      return;
    }
    sendJson(res, 200, { address: entry.address });
  }

  /** `GET /directory` — ogni voce che ha scelto di pubblicare un `label` (le altre si registrano solo per essere trovate da chi già conosce il loro `nodeId`, "rubrica privata" lato app — mai elencate qui). Mai l'indirizzo. */
  private handleDirectory(res: ServerResponse): void {
    const entries: DiscoveryDirectoryEntry[] = [];
    for (const entry of this.registrations.values()) {
      if (entry.label !== undefined) entries.push({ nodeId: entry.nodeId, label: entry.label, verified: entry.verified });
    }
    sendJson(res, 200, entries);
  }

  /**
   * `POST /admin/verify` — body `{nodeId, verified}`. Gated su `adminPassword`: senza una password
   * configurata all'avvio, questo endpoint resta sempre 404 — nessuna scrittura privilegiata senza un
   * admin che abbia esplicitamente scelto di abilitarla, stesso schema di `web-ui.ts`'s
   * `exposeEmergencyBeacons`/`exposeRelayRegistry`.
   */
  private async handleAdminVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.adminPassword) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !timingSafeStringEqual(authHeader, `Bearer ${this.adminPassword}`)) {
      sendJson(res, 401, { error: "missing or invalid admin password" });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRequestBody(req, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      if (err instanceof BodyTooLargeError) sendJson(res, 413, { error: "request body too large" });
      else sendJson(res, 400, { error: "failed to read request body" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "malformed JSON body" });
      return;
    }
    const body = parsed as { nodeId?: unknown; verified?: unknown } | null;
    if (typeof body?.nodeId !== "string" || body.nodeId.length === 0) {
      sendJson(res, 400, { error: "'nodeId' must be a non-empty string" });
      return;
    }
    if (typeof body.verified !== "boolean") {
      sendJson(res, 400, { error: "'verified' must be a boolean" });
      return;
    }
    const entry = this.registrations.get(body.nodeId);
    if (!entry) {
      sendJson(res, 404, { error: "unknown nodeId" });
      return;
    }
    entry.verified = body.verified;
    entry.verifiedAt = body.verified ? Date.now() : undefined;
    sendJson(res, 200, { ok: true, nodeId: entry.nodeId, verified: entry.verified });
  }
}

/** Confronto a tempo costante per la password admin — stessa `timingSafeStringEqual()` di `node/src/web-ui.ts` per `networkPassword` (trovato dalla revisione: un `!==` naive perde informazione sul numero di byte iniziali corrispondenti attraverso il tempo di risposta, rilevante qui perché questo servizio è pensato per essere esposto su Internet, `cli.ts` lega `0.0.0.0` di default). */
function timingSafeStringEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
