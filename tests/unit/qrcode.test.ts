import { describe, expect, it } from "vitest";
import { encodeQr, qrToSvg } from "../../node/src/qrcode.js";

/**
 * `encodeQr()`/`qrToSvg()` were verified during development against an independent decoder (jsQR,
 * used only as a throwaway development-time oracle — see node/src/qrcode.ts's doc comment) across
 * every version 1-10, every EC level, every one of the 8 mask patterns, and UTF-8 content — never
 * added as a project dependency, so it can't be re-run here. These tests instead check structural
 * invariants and known-fixed-point properties reachable through the public API alone: they catch a
 * regression that corrupts the matrix shape, picks the wrong version, or breaks determinism, but
 * they do NOT re-verify full decodability on every run (that would need a real QR decoder in the
 * repo, which the "no unnecessary dependency" rule in CLAUDE.md rules out) — same class of boundary
 * as this project's other "verified once, documented, can't fully re-verify in CI" cases (native
 * Android build, real BLE hardware).
 */
describe("encodeQr", () => {
  it("is deterministic — encoding the same text twice produces an identical matrix", () => {
    const a = encodeQr("nomadnet://pair?h=192.168.1.5:8080&n=Base&p=K7XM-2QRT");
    const b = encodeQr("nomadnet://pair?h=192.168.1.5:8080&n=Base&p=K7XM-2QRT");
    expect(a).toEqual(b);
  });

  it("returns undefined for text far beyond version 10's capacity, instead of throwing", () => {
    expect(encodeQr("x".repeat(1000))).toBeUndefined();
  });

  it("picks version 1 for a tiny payload and version 10 for one requiring maximum capacity", () => {
    const tiny = encodeQr("A");
    expect(tiny?.version).toBe(1);
    expect(tiny?.size).toBe(21);

    const big = encodeQr("x".repeat(210));
    expect(big?.version).toBe(10);
    expect(big?.size).toBe(57);
  });

  it("selects the smallest version that fits, growing version as payload length grows", () => {
    const versions = [10, 40, 90, 160].map((len) => encodeQr("x".repeat(len))?.version);
    expect(versions[0]).toBeLessThanOrEqual(versions[1]!);
    expect(versions[1]).toBeLessThanOrEqual(versions[2]!);
    expect(versions[2]).toBeLessThanOrEqual(versions[3]!);
  });

  it("produces a square matrix matching the spec's size formula (17 + 4*version)", () => {
    for (const len of [1, 50, 100, 200]) {
      const qr = encodeQr("x".repeat(len));
      if (!qr) continue;
      expect(qr.size).toBe(17 + 4 * qr.version);
      expect(qr.matrix.length).toBe(qr.size);
      for (const row of qr.matrix) expect(row.length).toBe(qr.size);
    }
  });

  it("places a correctly-shaped finder pattern (border ring + 3x3 core) in all three corners", () => {
    const qr = encodeQr("A")!;
    const isFinderShaped = (topRow: number, leftCol: number): boolean => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
          const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          const expectedDark = isBorder || isCore;
          if (qr.matrix[topRow + r][leftCol + c] !== expectedDark) return false;
        }
      }
      return true;
    };
    expect(isFinderShaped(0, 0)).toBe(true);
    expect(isFinderShaped(0, qr.size - 7)).toBe(true);
    expect(isFinderShaped(qr.size - 7, 0)).toBe(true);
  });

  it("alternates the timing pattern modules between the finder patterns", () => {
    const qr = encodeQr("A")!;
    for (let i = 8; i < qr.size - 8; i++) {
      expect(qr.matrix[6][i]).toBe(i % 2 === 0);
      expect(qr.matrix[i][6]).toBe(i % 2 === 0);
    }
  });

  it("sets the always-dark module at (4*version+9, 8) for a version needing version info", () => {
    const qr = encodeQr("x".repeat(160))!; // forces version >= 7
    expect(qr.version).toBeGreaterThanOrEqual(7);
    expect(qr.matrix[4 * qr.version + 9][8]).toBe(true);
  });
});

describe("qrToSvg", () => {
  it("renders a self-contained SVG with a viewBox matching (size + margin*2) * moduleSize", () => {
    const qr = encodeQr("A")!;
    const svg = qrToSvg(qr, { moduleSize: 6, margin: 4 });
    const dim = (qr.size + 8) * 6;
    expect(svg).toContain(`viewBox="0 0 ${dim} ${dim}"`);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("uses the spec-recommended default 4-module quiet zone when no margin is given", () => {
    const qr = encodeQr("A")!;
    const svg = qrToSvg(qr);
    const dim = (qr.size + 8) * 5; // default moduleSize=5, margin=4
    expect(svg).toContain(`viewBox="0 0 ${dim} ${dim}"`);
  });
});
