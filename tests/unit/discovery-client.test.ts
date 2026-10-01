import { describe, expect, it } from "vitest";
import { Identity } from "../../node/src/identity.js";
import { discoverySigningPayload, parseDiscoveryAddress, signDiscoveryRegistration, verifyDiscoveryRegistration } from "../../node/src/discovery-client.js";

describe("node/src/discovery-client (firma/verifica delle registrazioni di discovery)", () => {
  it("una registrazione appena firmata verifica con successo", () => {
    const identity = Identity.generate();
    const registration = signDiscoveryRegistration(identity, "203.0.113.5:9000", "Rifugio Test", Date.now());
    expect(registration.nodeId).toBe(identity.nodeId);
    expect(verifyDiscoveryRegistration(registration)).toBe(true);
  });

  it("funziona anche senza label (facoltativa — un nodo può registrare solo l'indirizzo, senza comparire nella rubrica pubblica)", () => {
    const identity = Identity.generate();
    const registration = signDiscoveryRegistration(identity, "203.0.113.5:9000", undefined, Date.now());
    expect(registration.label).toBeUndefined();
    expect(verifyDiscoveryRegistration(registration)).toBe(true);
  });

  it("manomettere l'indirizzo dopo la firma invalida la verifica", () => {
    const identity = Identity.generate();
    const registration = signDiscoveryRegistration(identity, "203.0.113.5:9000", "Rifugio Test", Date.now());
    const tampered = { ...registration, address: "198.51.100.1:9000" };
    expect(verifyDiscoveryRegistration(tampered)).toBe(false);
  });

  it("manomettere la label dopo la firma invalida la verifica (il label è coperto dalla firma, non solo l'indirizzo)", () => {
    const identity = Identity.generate();
    const registration = signDiscoveryRegistration(identity, "203.0.113.5:9000", "Rifugio Test", Date.now());
    const tampered = { ...registration, label: "Nome diverso" };
    expect(verifyDiscoveryRegistration(tampered)).toBe(false);
  });

  it("una firma di un'identità diversa, riproposta per un altro nodeId, non verifica", () => {
    const victim = Identity.generate();
    const attacker = Identity.generate();
    const forged = { ...signDiscoveryRegistration(attacker, "203.0.113.5:9000", undefined, Date.now()), nodeId: victim.nodeId };
    expect(verifyDiscoveryRegistration(forged)).toBe(false);
  });

  it("nodeId/signature malformati non lanciano, restituiscono false", () => {
    expect(verifyDiscoveryRegistration({ nodeId: "not-hex!!", address: "a:1", label: undefined, timestamp: 1, signature: "zz" })).toBe(false);
    expect(verifyDiscoveryRegistration({ nodeId: Identity.generate().nodeId, address: "a:1", label: undefined, timestamp: 1, signature: "not-hex!!" })).toBe(false);
  });

  it("discoverySigningPayload() produce byte diversi per campi diversi (nessuna collisione banale tra label/address)", () => {
    const a = discoverySigningPayload({ nodeId: "n1", address: "a:1", label: undefined, timestamp: 1 });
    const b = discoverySigningPayload({ nodeId: "n1", address: "a:1", label: "x", timestamp: 1 });
    expect(a.equals(b)).toBe(false);
  });

  describe("parseDiscoveryAddress()", () => {
    it("analizza un host:port semplice (IPv4 o nome host)", () => {
      expect(parseDiscoveryAddress("203.0.113.5:9000")).toEqual({ host: "203.0.113.5", port: 9000 });
      expect(parseDiscoveryAddress("rifugio.example.org:9000")).toEqual({ host: "rifugio.example.org", port: 9000 });
    });

    it("analizza un [ipv6]:port senza troncare l'indirizzo sui due punti interni (bug reale trovato dalla revisione: uno split naive su ':' produceva host '[' e porta 0)", () => {
      expect(parseDiscoveryAddress("[2001:db8::1]:9000")).toEqual({ host: "2001:db8::1", port: 9000 });
      expect(parseDiscoveryAddress("[::1]:9000")).toEqual({ host: "::1", port: 9000 });
    });

    it("lancia su un indirizzo IPv6 malformato (parentesi non chiusa)", () => {
      expect(() => parseDiscoveryAddress("[::1:9000")).toThrow(/malformato/);
    });

    it("lancia su un indirizzo senza porta", () => {
      expect(() => parseDiscoveryAddress("soloindirizzo")).toThrow(/malformato/);
    });
  });
});
