import { describe, expect, it } from "vitest";
import { resolveNetworkPassword } from "../../node/src/network-password-source.js";

describe("resolveNetworkPassword", () => {
  const file = (content: string, mode = 0o600) => ({ file: "/etc/arald/pw", readFile: () => content, fileMode: () => mode });

  it("nessuna sorgente: undefined (il nodo ne genera una)", () => {
    expect(resolveNetworkPassword({})).toBeUndefined();
    expect(resolveNetworkPassword({ env: "" })).toBeUndefined();
  });

  it("da file: toglie un solo a-capo finale, nessun avviso con permessi 600", () => {
    const r = resolveNetworkPassword(file("segreta-1\n"))!;
    expect(r).toEqual({ password: "segreta-1", source: "file", warnings: [] });
    expect(resolveNetworkPassword(file("a b\r\n"))!.password).toBe("a b");
  });

  it("da file con permessi larghi: avviso (non su Windows)", () => {
    expect(resolveNetworkPassword(file("x", 0o644))!.warnings[0]).toContain("chmod 600");
    expect(resolveNetworkPassword({ ...file("x", 0o644), platform: "win32" })!.warnings).toEqual([]);
  });

  it("file vuoto o illeggibile: errore chiaro", () => {
    expect(() => resolveNetworkPassword(file("\n"))).toThrow("vuoto");
    expect(() => resolveNetworkPassword({ file: "/nope", readFile: () => { throw new Error("ENOENT"); } })).toThrow("impossibile leggere");
  });

  it("da variabile d'ambiente: nessun avviso", () => {
    expect(resolveNetworkPassword({ env: "dall-ambiente" })).toEqual({ password: "dall-ambiente", source: "env", warnings: [] });
  });

  it("da flag: funziona ma avvisa che finisce in ps e nel journal", () => {
    const r = resolveNetworkPassword({ flag: "in-chiaro" })!;
    expect(r.source).toBe("flag");
    expect(r.warnings[0]).toContain("ps");
  });

  it("flag e file insieme: errore; l'ambiente è la sorgente più debole e viene sostituito", () => {
    expect(() => resolveNetworkPassword({ ...file("x"), flag: "a" })).toThrow("sia con");
    expect(resolveNetworkPassword({ ...file("dal-file"), env: "b" })!.password).toBe("dal-file");
    expect(resolveNetworkPassword({ flag: "dal-flag", env: "b" })!.password).toBe("dal-flag");
  });

  it("file con BOM, a-capo finale, UTF-16 e password vuota da flag", () => {
    expect(resolveNetworkPassword(file("\uFEFFsegreta\r\n"))!.password).toBe("segreta");
    expect(() => resolveNetworkPassword(file("s\0e\0g\0"))).toThrow("UTF-8");
    expect(() => resolveNetworkPassword({ flag: "" })).toThrow("vuota");
  });
});
