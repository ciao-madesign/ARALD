import { networkInterfaces } from "node:os";

/**
 * Indirizzi della macchina su cui gira il nodo, e «questa richiesta viene dalla macchina stessa?». Usato dal
 * `WebUiServer` per due decisioni: `GET /api/pairing` (password e QR solo a chi è sulla macchina del nodo, docs/security.md
 * voce #144) e l'esenzione del limite ai tentativi sulla password (`auth-throttle.ts`, voce #143).
 *
 * **Limiti noti**: qualunque inoltro sulla stessa macchina fa sembrare locali richieste remote — proxy inverso (nginx,
 * Caddy), tunnel `ssh -L`, mappatura di porte Docker (`-p`, la richiesta arriva dall'indirizzo del bridge). In quei
 * casi la password non è più riservata: va saputo, o va usato `--pairing-on-lan` con piena consapevolezza.
 * `X-Forwarded-For` non si usa mai: è falsificabile da chiunque.
 */

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

/** Indirizzo normalizzato: IPv4 mappato in IPv6 ridotto a IPv4; IPv6 espanso, senza zeri iniziali e in minuscolo; senza scope (`%eth0`). */
export function normalizeAddress(raw: string | undefined): string {
  const ip = (raw ?? "?").replace(/^::ffff:/i, "").replace(/%.*$/, "");
  if (!ip.includes(":")) return ip;
  return expandIpv6(ip).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
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

/** Vero se l'indirizzo remoto di una connessione è uno degli indirizzi della macchina stessa (loopback compreso). */
export function isThisMachine(remoteAddress: string | undefined, addresses: () => Set<string> = machineAddresses): boolean {
  if (remoteAddress === undefined) return false;
  const addr = normalizeAddress(remoteAddress);
  if (addresses().has(addr)) return true;
  // Indirizzo non in cache: potrebbe essere appena assegnato (DHCP, hotspot). Rilettura, al più una ogni 2 s.
  if (addresses === machineAddresses && cachedMachine && Date.now() - cachedMachine.at > 2_000) {
    cachedMachine = undefined;
    return machineAddresses().has(addr);
  }
  return false;
}
