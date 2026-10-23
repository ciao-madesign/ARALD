import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findArgProblems, KNOWN_FLAGS } from "../../node/src/cli-args.js";

describe("cli-args: avvisi su flag sbagliati", () => {
  it("nessun avviso con flag noti, valori e flag booleani", () => {
    expect(findArgProblems(["--id", "BOX", "--port", "9001", "--allow-service-calls", "true", "--portable"])).toEqual([]);
  });

  it("«-- identity-dir» (spazio di troppo) viene segnalato con il suggerimento", () => {
    const p = findArgProblems(["--id", "BOX", "--", "identity-dir", "/var/lib/arald"]);
    expect(p.some((m) => m.includes("--identity-dir"))).toBe(true);
    expect(p.some((m) => m.includes("/var/lib/arald"))).toBe(false); // il valore rimasto senza flag non si mostra mai
    expect(p.some((m) => m.includes("senza") || m.includes("non mostrato"))).toBe(true);
  });

  it("flag sconosciuto o con errore di battitura: avviso con «forse intendevi»", () => {
    const p = findArgProblems(["--identiti-dir", "/x", "--zzzzzzzzzzzz"]);
    expect(p[0]).toContain("--identity-dir");
    expect(p[1]).toContain("sconosciuto");
    expect(p[1]).not.toContain("forse intendevi");
  });

  it("mai il valore di un possibile segreto negli avvisi", () => {
    const all = [
      ...findArgProblems(["--", "network-password", "S3cret-Value"]),
      ...findArgProblems(["--network-password", "--S3cret_Value"]),
      ...findArgProblems(["--S3cret_Value"]),
      ...findArgProblems(["S3cret-Value"]),
    ].join("\n");
    expect(all).not.toMatch(/S3cret/i);
  });

  it("nessun «forse intendevi» spurio per --help/--version/nomi corti", () => {
    for (const f of ["--help", "--version", "--h", "--ip"]) expect(findArgProblems([f])[0]).not.toContain("forse intendevi");
  });

  it("«--» da solo e argomenti senza flag", () => {
    expect(findArgProblems(["--"]).length).toBe(1);
    expect(findArgProblems(["--port", "9001", "extra"]).length).toBe(1);
  });

  it("l'elenco dei flag noti copre tutto ciò che cli.ts legge", () => {
    const src = readFileSync(new URL("../../node/src/cli.ts", import.meta.url), "utf8");
    const used = new Set<string>();
    for (const m of src.matchAll(/args\[["']([a-z0-9-]+)["']\]/g)) used.add(m[1]);
    for (const m of src.matchAll(/(?<![-\w/])args\.([a-z]+)\b/g)) used.add(m[1]);
    const missing = [...used].filter((f) => !KNOWN_FLAGS.includes(f));
    expect(missing).toEqual([]);
  });
});
