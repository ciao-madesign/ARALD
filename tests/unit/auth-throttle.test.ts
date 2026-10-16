import { describe, expect, it } from "vitest";
import { networkInterfaces } from "node:os";
import { AuthFailureThrottle, DEFAULT_AUTH_MAX_FAILURES, ipLimiterKey, machineAddresses, normalizeAddress } from "../../node/src/auth-throttle.js";

describe("chiave del limite", () => {
  it("normalizza IPv4 mappato e raggruppa IPv6 per /64", () => {
    expect(ipLimiterKey("192.168.1.20")).toBe("192.168.1.20");
    expect(ipLimiterKey("::ffff:192.168.1.20")).toBe("192.168.1.20");
    expect(ipLimiterKey("fe80:0:0:1:aaaa:bbbb:cccc:dddd")).toBe(ipLimiterKey("fe80:0:0:1:1:2:3:4"));
    expect(normalizeAddress("FE80::0005%eth0")).toBe("fe80:0:0:0:0:0:0:5");
    expect(normalizeAddress("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(ipLimiterKey("fe80::5")).toBe(ipLimiterKey("fe80:0:0:0:9:8:7:6"));
    expect(ipLimiterKey("fe80:0:0:2:aaaa:bbbb:cccc:dddd")).not.toBe(ipLimiterKey("fe80:0:0:1:aaaa:bbbb:cccc:dddd"));
    expect(ipLimiterKey(undefined)).toBe("?");
  });
});

describe("AuthFailureThrottle", () => {
  const A = "192.168.1.20";
  const B = "192.168.1.21";
  const make = (extra = {}) => {
    let t = 1_000_000;
    const th = new AuthFailureThrottle({ maxFailures: 3, windowMs: 60_000, exemptLocal: false, now: () => t, ...extra });
    return { th, advance: (ms: number) => { t += ms; } };
  };

  it("blocca un indirizzo dopo i tentativi sbagliati, non gli altri, e si sblocca a fine finestra", () => {
    const { th, advance } = make();
    for (let i = 0; i < 2; i++) th.recordFailure(A);
    expect(th.lockedForSeconds(A)).toBe(0);
    th.recordFailure(A);
    expect(th.lockedForSeconds(A)).toBeGreaterThan(0);
    expect(th.lockedForSeconds(B)).toBe(0); // nessun blocco globale: un ospite non chiude gli altri
    advance(59_000);
    expect(th.lockedForSeconds(A)).toBe(1);
    advance(1_001);
    expect(th.lockedForSeconds(A)).toBe(0);
    th.recordFailure(A); // la finestra riparte
    expect(th.lockedForSeconds(A)).toBe(0);
  });

  it("un tentativo riuscito azzera il conteggio", () => {
    const { th } = make();
    th.recordFailure(A); th.recordFailure(A);
    th.recordSuccess(A);
    th.recordFailure(A); th.recordFailure(A);
    expect(th.lockedForSeconds(A)).toBe(0);
  });

  it("la macchina stessa non è limitata (il Local Portal ha il proprio limite per ospite)", () => {
    let t = 0;
    const th = new AuthFailureThrottle({ maxFailures: 1, now: () => t, localAddresses: () => new Set(["192.168.1.5", "127.0.0.1"]) });
    for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "192.168.1.5", "::ffff:192.168.1.5"]) { th.recordFailure(ip); th.recordFailure(ip); expect(th.lockedForSeconds(ip), ip).toBe(0); }
    th.recordFailure("192.168.1.99");
    expect(th.lockedForSeconds("192.168.1.99")).toBeGreaterThan(0);
    t += 1;
  });

  it("la mappa è limitata: oltre il tetto si scarta il più vecchio, non tutto", () => {
    const { th } = make({ maxFailures: 1, maxTracked: 3 });
    for (const ip of ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]) th.recordFailure(ip);
    expect(th.trackedCount).toBe(3);
    expect(th.lockedForSeconds("10.0.0.1")).toBe(0); // il più vecchio è stato scartato
    expect(th.lockedForSeconds("10.0.0.4")).toBeGreaterThan(0);
    expect(th.lockedForSeconds("10.0.0.2")).toBeGreaterThan(0); // gli altri bloccati restano bloccati
  });

  it("IPv6: un ospite non blocca gli altri dispositivi dello stesso /64 con i suoi primi errori; ruotare gli indirizzi si ferma al limite del prefisso", () => {
    const { th } = make({ maxFailures: 3 });
    const guest = "fd12:3456:789a:1::99";
    const operator = "fd12:3456:789a:1::5"; // stesso /64
    for (let i = 0; i < 3; i++) th.recordFailure(guest);
    expect(th.lockedForSeconds(guest)).toBeGreaterThan(0);
    expect(th.lockedForSeconds(operator)).toBe(0); // l'operatore non paga per l'ospite
    // l'ospite cambia indirizzo dentro il /64: ogni indirizzo nuovo ha il suo limite, ma il prefisso si chiude a 3 × 5 = 15 errori totali
    for (let i = 0; i < 12; i++) th.recordFailure(`fd12:3456:789a:1::${100 + i}`);
    expect(th.lockedForSeconds("fd12:3456:789a:1::999")).toBeGreaterThan(0); // un indirizzo mai visto, già bloccato dal prefisso
    expect(th.lockedForSeconds("fd12:3456:789a:2::5")).toBe(0); // un altro prefisso no
  });

  it("chi è bloccato si scarta per ultimo: inondare la mappa non sfratta il blocco", () => {
    const { th } = make({ maxFailures: 1, maxTracked: 4 });
    th.recordFailure("10.0.0.1"); // bloccato (limite 1)
    expect(th.lockedForSeconds("10.0.0.1")).toBeGreaterThan(0);
    // il limite è 1: ogni altro indirizzo si blocca subito; con maxFailures 3 gli altri restano non bloccati e si sfrattano fra loro
    const { th: t2 } = make({ maxFailures: 2, maxTracked: 4 });
    t2.recordFailure("10.0.0.1"); t2.recordFailure("10.0.0.1");
    expect(t2.lockedForSeconds("10.0.0.1")).toBeGreaterThan(0);
    for (let i = 2; i < 40; i++) t2.recordFailure(`10.0.0.${i}`); // un errore ciascuno: non bloccati
    expect(t2.lockedForSeconds("10.0.0.1")).toBeGreaterThan(0);
    expect(t2.trackedCount).toBeLessThanOrEqual(4);
  });

  it("l'elenco degli indirizzi della macchina viene dal sistema, con maiuscole, scope e IPv4 mappato normalizzati", () => {
    const set = machineAddresses();
    expect(set.has("127.0.0.1")).toBe(true);
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) expect(set.has(normalizeAddress(a.address))).toBe(true);
    const th = new AuthFailureThrottle({ maxFailures: 1 }); // predefinito: elenco reale
    th.recordFailure("::ffff:127.0.0.1");
    th.recordFailure("::1");
    expect(th.lockedForSeconds("127.0.0.1")).toBe(0);
  });

  it("valori non numerici ricadono sui predefiniti, non spengono il limite", () => {
    const th = new AuthFailureThrottle({ maxFailures: Number("abc"), windowMs: Number("x"), maxTracked: Number.NaN, exemptLocal: false });
    for (let i = 0; i < DEFAULT_AUTH_MAX_FAILURES; i++) th.recordFailure(A);
    expect(th.lockedForSeconds(A)).toBeGreaterThan(0);
  });

  it("valori di default ragionevoli", () => {
    expect(DEFAULT_AUTH_MAX_FAILURES).toBe(10);
  });
});
