import { networkInterfaces } from "node:os";
import { BoundedFifoMap } from "./bounded-map.js";

/**
 * Limite ai tentativi sbagliati sulla password di rete (`WebUiServer`, docs/security.md voce #141). Prima di questa voce il
 * confronto della password era in tempo costante ma nulla limitava quante ne si potessero provare: chiunque sul LAN poteva
 * provarle a piena velocità su qualunque endpoint protetto.
 *
 * Scelte (dalle revisioni della voce #140 e #141):
 * - **per indirizzo, mai globale**: un limite globale lascerebbe a un ospite del LAN il modo di chiudere l'accesso a tutti
 *   gli operatori. Un indirizzo bloccato non blocca gli altri;
 * - IPv4 mappato in IPv6 → IPv4. IPv6: due livelli, l'indirizzo intero (limite `maxFailures`) e il prefisso /64 (limite
 *   `maxFailures` × 5): un ospite che ruota gli indirizzi dentro il suo /64 si ferma al limite del prefisso, ma un solo
 *   ospite non può bloccare gli altri dispositivi dello stesso /64 (in una LAN con SLAAC lo condividono tutti) con i suoi
 *   primi errori;
 * - **si contano solo le password presentate e sbagliate** (un'intestazione `Authorization` presente ma che non
 *   corrisponde), non le richieste senza intestazione; e solo sugli endpoint protetti (`WebUiServer.authorize()`);
 * - un tentativo riuscito azzera il conteggio dell'indirizzo: chi ha già la password non ha più nulla da indovinare;
 * - le richieste che arrivano dalla macchina stessa (loopback o uno dei suoi indirizzi) non sono limitate: è il caso del Local
 *   Portal (`local-portal/`) che verifica la password a nome degli ospiti e ha già il proprio limite per indirizzo, e un
 *   processo locale non ha bisogno di indovinare la password. **Limite noto**: un proxy inverso sulla stessa macchina che
 *   inoltri l'intestazione `Authorization` di client remoti li farebbe sembrare locali (`X-Forwarded-For` non si usa mai:
 *   è falsificabile); con un proxy così si può togliere l'esenzione (`exemptLocal: false`, `--auth-throttle-include-local`);
 * - la mappa dei conteggi è limitata (spec §57): oltre il tetto si scarta prima chi non è bloccato (un attaccante non può
 *   sfrattare il proprio blocco inondando la mappa di altri indirizzi), poi il più vecchio, mai tutto.
 */
export interface AuthThrottleOptions {
  /** Tentativi sbagliati ammessi per indirizzo nella finestra (default 10). */
  maxFailures?: number;
  /** Durata della finestra in ms (default 10 minuti): dopo `maxFailures` errori l'indirizzo aspetta la fine della finestra, contata dal primo errore. */
  windowMs?: number;
  /** Chiavi tracciate al massimo (default 1000). */
  maxTracked?: number;
  /** Non limitare le richieste dalla macchina stessa (default true; i test lo spengono per provare il limite da loopback). */
  exemptLocal?: boolean;
  now?: () => number;
  /** Indirizzi della macchina, già normalizzati (iniettabile nei test). */
  localAddresses?: () => Set<string>;
}

export const DEFAULT_AUTH_MAX_FAILURES = 10;
export const DEFAULT_AUTH_WINDOW_MS = 600_000;
/** Moltiplicatore del limite sul prefisso /64 rispetto al limite per indirizzo intero. */
const PREFIX_LIMIT_FACTOR = 5;

function expandIpv6(ip: string): string[] {
  const groups = ip.toLowerCase().split(":");
  const i = groups.indexOf("");
  if (i >= 0 && ip.includes("::")) {
    const head = groups.slice(0, i).filter(Boolean);
    const tail = groups.slice(i + 1).filter(Boolean);
    return [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
  }
  return groups;
}

/** Indirizzo normalizzato: IPv4 mappato in IPv6 ridotto a IPv4; IPv6 espanso, senza zeri iniziali e in minuscolo. */
export function normalizeAddress(raw: string | undefined): string {
  const ip = (raw ?? "?").replace(/^::ffff:/i, "").replace(/%.*$/, "");
  if (!ip.includes(":")) return ip;
  return expandIpv6(ip).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

/** Chiave del prefisso /64 di un indirizzo IPv6 (per un IPv4: l'indirizzo stesso). */
export function ipLimiterKey(raw: string | undefined): string {
  const ip = normalizeAddress(raw);
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

let cachedMachine: { at: number; set: Set<string> } | undefined;
const MACHINE_CACHE_MS = 30_000;

/** Indirizzi della macchina (normalizzati), riletti al più ogni 30 s: possono cambiare (DHCP, punto di accesso che si accende). */
export function machineAddresses(): Set<string> {
  const now = Date.now();
  if (cachedMachine && now - cachedMachine.at < MACHINE_CACHE_MS) return cachedMachine.set;
  const out = new Set<string>(["127.0.0.1", "::1"].map(normalizeAddress));
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) out.add(normalizeAddress(a.address));
  cachedMachine = { at: now, set: out };
  return out;
}

export class AuthFailureThrottle {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly exemptLocal: boolean;
  private readonly now: () => number;
  private readonly localAddresses: () => Set<string>;
  private readonly entries: BoundedFifoMap<string, { count: number; since: number; limit: number }>;

  constructor(options: AuthThrottleOptions = {}) {
    // valori non numerici (un flag di riga di comando sbagliato) ricadono sul predefinito invece di spegnere il limite in silenzio
    const positive = (v: number | undefined, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? v : fallback);
    this.maxFailures = Math.floor(positive(options.maxFailures, DEFAULT_AUTH_MAX_FAILURES));
    this.windowMs = positive(options.windowMs, DEFAULT_AUTH_WINDOW_MS);
    this.exemptLocal = options.exemptLocal ?? true;
    this.now = options.now ?? Date.now;
    this.localAddresses = options.localAddresses ?? machineAddresses;
    // chi ha già raggiunto il proprio limite (bloccato) si scarta per ultimo
    this.entries = new BoundedFifoMap({ maxSize: Math.floor(positive(options.maxTracked, 1000)), evictionScore: (_k, e) => (e.count >= e.limit ? 1 : 0) });
  }

  private isLocal(raw: string | undefined): boolean {
    if (!this.exemptLocal || raw === undefined) return false;
    return this.localAddresses().has(normalizeAddress(raw));
  }

  /** Le chiavi da controllare per un indirizzo: l'indirizzo intero e, per IPv6, il prefisso /64 (con un limite cinque volte più alto). */
  private keys(address: string | undefined): { key: string; limit: number }[] {
    const full = normalizeAddress(address);
    const out = [{ key: `a:${full}`, limit: this.maxFailures }];
    if (full.includes(":")) out.push({ key: `p:${ipLimiterKey(address)}`, limit: this.maxFailures * PREFIX_LIMIT_FACTOR });
    return out;
  }

  /** Secondi da aspettare se l'indirizzo è bloccato, altrimenti 0. Non modifica nulla. */
  lockedForSeconds(address: string | undefined): number {
    const now = this.now();
    let wait = 0;
    for (const { key, limit } of this.keys(address)) {
      const e = this.entries.get(key);
      if (!e || e.count < limit) continue;
      const left = e.since + this.windowMs - now;
      if (left > 0) wait = Math.max(wait, Math.ceil(left / 1000));
    }
    return wait;
  }

  /** Una password presentata e sbagliata. */
  recordFailure(address: string | undefined): void {
    if (this.isLocal(address)) return;
    const now = this.now();
    for (const { key, limit } of this.keys(address)) {
      const e = this.entries.get(key);
      if (!e || now - e.since >= this.windowMs) this.entries.set(key, { count: 1, since: now, limit });
      else e.count++;
    }
  }

  /** Una password giusta: l'indirizzo riparte da zero (il prefisso /64 condiviso con altri dispositivi non si azzera). */
  recordSuccess(address: string | undefined): void {
    this.entries.delete(this.keys(address)[0].key);
  }

  get trackedCount(): number {
    return this.entries.size;
  }
}
