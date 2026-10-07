import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("pagina del tool: build in un unico file", () => {
  it("produce un HTML autosufficiente, senza dipendenze da Node né script esterni", () => {
    execFileSync("node", ["tools/network-design/build.mjs"], { stdio: "pipe" });
    const html = readFileSync("tools/network-design/dist/index.html", "utf8");
    expect(html.length).toBeGreaterThan(30_000);
    expect(html).toContain("<title>ARALD Network Design Tool</title>");
    expect(html).not.toContain("/*__BUNDLE__*/");
    expect(html).not.toMatch(/require\(["']node:/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    const frag = readFileSync("tools/network-design/dist/artifact.html", "utf8");
    expect(frag).not.toMatch(/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i);
    expect(frag).toContain("<title>ARALD Network Design Tool</title>");
    // `[hidden]` deve vincere sugli stili di layout, altrimenti la finestra di configurazione resta aperta
    expect(html).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  }, 60_000);

  it("il bundle non può chiudere il suo tag <script> dall'interno", () => {
    const frag = readFileSync("tools/network-design/dist/artifact.html", "utf8");
    const open = frag.lastIndexOf("<script>");
    const inner = frag.slice(open + "<script>".length, frag.lastIndexOf("</script>"));
    expect(inner).not.toMatch(/<\/script/i);
    expect(inner.length).toBeGreaterThan(20_000);
    expect(() => new Function(inner)).not.toThrow(); // il bundle è JavaScript valido
  }, 60_000);
});
