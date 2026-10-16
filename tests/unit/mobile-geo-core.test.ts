import { describe, expect, it } from "vitest";
import {
  MIN_DIRECTION_DISTANCE_M,
  bearingDegrees,
  compassName,
  compassPoint,
  describeTarget,
  formatDistance,
  haversineDistanceMeters,
} from "../../mobile/www/geo-core.js";

// I valori attesi sono stati calcolati con un'implementazione Python indipendente della stessa formula
// (raggio terrestre 6371000 m) — sono i vettori di riferimento che un'altra piattaforma (Watch, firmware)
// deve riprodurre (docs/external-inspiration.md, "ARALD GEO CORE").
describe("mobile/www/geo-core (ARALD GEO CORE, docs/security.md voce #141)", () => {
  describe("haversineDistanceMeters", () => {
    it("matches the reference vectors", () => {
      expect(haversineDistanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(111194.927, 1);
      expect(haversineDistanceMeters({ lat: 0, lon: 179 }, { lat: 0, lon: -179 })).toBeCloseTo(222389.853, 1); // across the antimeridian
      expect(haversineDistanceMeters({ lat: 41.9028, lon: 12.4964 }, { lat: 48.8566, lon: 2.3522 })).toBeCloseTo(1105280.149, 0);
      expect(haversineDistanceMeters({ lat: 90, lon: 0 }, { lat: 0, lon: 0 })).toBeCloseTo(10007543.398, 0);
    });

    it("handles antipodal points (the Math.min(1, …) clamp) and longitude -180 vs 180", () => {
      expect(haversineDistanceMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(20015086.796, 0);
      expect(haversineDistanceMeters({ lat: 10, lon: 20 }, { lat: -10, lon: -160 })).toBeCloseTo(20015086.796, 0);
      expect(haversineDistanceMeters({ lat: 0, lon: 180 }, { lat: 0, lon: -180 })).toBeLessThan(0.001);
    });

    it("is zero for the same point and symmetric", () => {
      const a = { lat: 45.1, lon: 7.2 };
      const b = { lat: 44.9, lon: 7.4 };
      expect(haversineDistanceMeters(a, a)).toBe(0);
      expect(haversineDistanceMeters(a, b)).toBeCloseTo(haversineDistanceMeters(b, a) as number, 6);
    });

    it("returns undefined, never NaN or a throw, for an invalid point", () => {
      const ok = { lat: 45, lon: 7 };
      for (const bad of [undefined, null, {}, { lat: "45", lon: 7 }, { lat: NaN, lon: 7 }, { lat: Infinity, lon: 7 }, { lat: 91, lon: 7 }, { lat: 45, lon: 181 }, { lat: 45 }]) {
        expect(haversineDistanceMeters(ok, bad as never)).toBeUndefined();
        expect(haversineDistanceMeters(bad as never, ok)).toBeUndefined();
      }
    });
  });

  describe("bearingDegrees", () => {
    it("matches the reference vectors", () => {
      expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
      expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
      expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 6);
      expect(bearingDegrees({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })).toBeCloseTo(180, 6);
      expect(bearingDegrees({ lat: 0, lon: 179 }, { lat: 0, lon: -179 })).toBeCloseTo(90, 6); // east, across the antimeridian
      expect(bearingDegrees({ lat: 41.9028, lon: 12.4964 }, { lat: 48.8566, lon: 2.3522 })).toBeCloseTo(317.831, 2);
      expect(bearingDegrees({ lat: 45, lon: 7 }, { lat: 45.003, lon: 7.004 })).toBeCloseTo(43.312, 2);
    });

    it("always lands in [0, 360)", () => {
      for (const to of [{ lat: 0, lon: -0.0001 }, { lat: -1, lon: -1 }, { lat: 1, lon: -1 }, { lat: -1, lon: 1 }]) {
        const b = bearingDegrees({ lat: 0, lon: 0 }, to) as number;
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(360);
      }
    });

    it("is undefined for identical points (no direction, never an inherited 'north') or invalid input", () => {
      expect(bearingDegrees({ lat: 45, lon: 7 }, { lat: 45, lon: 7 })).toBeUndefined();
      expect(bearingDegrees({ lat: 45, lon: 7 }, { lat: NaN, lon: 7 })).toBeUndefined();
    });

    it("is undefined for points that coincide with different coordinates (longitude -180 vs 180, two points on a pole) — code-review finding", () => {
      expect(bearingDegrees({ lat: 0, lon: 180 }, { lat: 0, lon: -180 })).toBeUndefined();
      expect(bearingDegrees({ lat: 90, lon: 0 }, { lat: 90, lon: 50 })).toBeUndefined();
      expect(bearingDegrees({ lat: -90, lon: 10 }, { lat: -90, lon: -170 })).toBeUndefined();
    });

    it("from a pole every direction is south (north pole) or north (south pole), whatever the longitude", () => {
      expect(bearingDegrees({ lat: 90, lon: 0 }, { lat: 0, lon: 0 })).toBe(180);
      expect(bearingDegrees({ lat: 90, lon: 77 }, { lat: 45, lon: -30 })).toBe(180);
      expect(bearingDegrees({ lat: -90, lon: 0 }, { lat: 0, lon: 123 })).toBe(0);
    });

    it("towards a pole is due north/south", () => {
      expect(bearingDegrees({ lat: 45, lon: 7 }, { lat: 90, lon: 0 })).toBeCloseTo(0, 6);
      expect(bearingDegrees({ lat: -45, lon: 7 }, { lat: -90, lon: 0 })).toBeCloseTo(180, 6);
    });
  });

  describe("compassPoint", () => {
    it("maps the eight sectors, centred on the cardinal/intercardinal directions", () => {
      expect(compassPoint(0)).toBe("N");
      expect(compassPoint(22.4)).toBe("N");
      expect(compassPoint(22.6)).toBe("NE");
      expect(compassPoint(90)).toBe("E");
      expect(compassPoint(135)).toBe("SE");
      expect(compassPoint(180)).toBe("S");
      expect(compassPoint(225)).toBe("SO");
      expect(compassPoint(270)).toBe("O");
      expect(compassPoint(315)).toBe("NO");
      expect(compassPoint(337.6)).toBe("N"); // wraps back to north
      expect(compassPoint(359.9)).toBe("N");
    });

    it("exact sector boundaries round half up — 22.5 is NE, 337.5 is N — the tie-break a port to another language must reproduce", () => {
      expect(compassPoint(22.5)).toBe("NE");
      expect(compassPoint(67.5)).toBe("E");
      expect(compassPoint(337.5)).toBe("N");
      expect(compassPoint(292.5)).toBe("NO");
    });

    it("compassName spells the point out for tooltips/screen readers, never a lone 'O'", () => {
      expect(compassName(0)).toBe("nord");
      expect(compassName(45)).toBe("nord-est");
      expect(compassName(225)).toBe("sud-ovest");
      expect(compassName(270)).toBe("ovest");
      expect(compassName(315)).toBe("nord-ovest");
      expect(compassName(NaN)).toBeUndefined();
    });

    it("normalizes out-of-range input and rejects non-numbers", () => {
      expect(compassPoint(360)).toBe("N");
      expect(compassPoint(-90)).toBe("O");
      expect(compassPoint(NaN)).toBeUndefined();
      expect(compassPoint("90" as never)).toBeUndefined();
    });
  });

  describe("formatDistance", () => {
    it("keeps the format the app already showed before this module existed", () => {
      expect(formatDistance(0)).toBe("0 m");
      expect(formatDistance(849.6)).toBe("850 m");
      expect(formatDistance(999.4)).toBe("999 m");
      expect(formatDistance(1000)).toBe("1.0 km");
      expect(formatDistance(1234)).toBe("1.2 km");
    });

    it("is undefined for a negative or non-finite value", () => {
      expect(formatDistance(-1)).toBeUndefined();
      expect(formatDistance(NaN)).toBeUndefined();
      expect(formatDistance(Infinity)).toBeUndefined();
    });
  });

  describe("describeTarget", () => {
    it("gives distance, direction and a ready label", () => {
      const result = describeTarget({ lat: 45, lon: 7 }, { lat: 45.003, lon: 7.004 });
      expect(result?.distanceM).toBeCloseTo(458.463, 1);
      expect(result?.bearingDegrees).toBeCloseTo(43.312, 2);
      expect(result?.compass).toBe("NE");
      expect(result?.label).toBe("458 m NE");
    });

    it("omits the direction below MIN_DIRECTION_DISTANCE_M — GPS error is the same order, a direction there would be noise", () => {
      // ~4.4 m north.
      const result = describeTarget({ lat: 45, lon: 7 }, { lat: 45.00004, lon: 7 });
      expect(result?.distanceM).toBeLessThan(MIN_DIRECTION_DISTANCE_M);
      expect(result?.bearingDegrees).toBeUndefined();
      expect(result?.compass).toBeUndefined();
      expect(result?.label).toBe("4 m");
    });

    it("omits the direction when the fix's own accuracy would move it past half a compass sector (accuracy > 0.38 × distance) — a confident wrong direction is worse than none (code-review finding)", () => {
      const to = { lat: 45.003, lon: 7.004 }; // ~458 m away, NE → threshold ~174 m
      expect(describeTarget({ lat: 45, lon: 7, accuracy: 300 }, to)?.label).toBe("458 m");
      expect(describeTarget({ lat: 45, lon: 7, accuracy: 220 }, to)?.compass).toBeUndefined(); // passed the old "half the distance" rule, rightly dropped now
      expect(describeTarget({ lat: 45, lon: 7, accuracy: 170 }, to)?.label).toBe("458 m NE");
      expect(describeTarget({ lat: 45, lon: 7, accuracy: 0 }, to)?.label).toBe("458 m NE");
      expect(describeTarget({ lat: 45, lon: 7 }, to)?.label).toBe("458 m NE"); // accuracy unknown: not penalized
    });

    it("a negative or NaN accuracy is 'unknown', neither a perfect nor a terrible fix", () => {
      const to = { lat: 45.003, lon: 7.004 };
      expect(describeTarget({ lat: 45, lon: 7, accuracy: -1 }, to)?.label).toBe("458 m NE");
      expect(describeTarget({ lat: 45, lon: 7, accuracy: NaN }, to)?.label).toBe("458 m NE");
    });

    it("the 1 km boundary is decided on the rounded value, and short/long forms agree (999.6 m is '1.0 km', never '1000 m')", () => {
      expect(formatDistance(999.6)).toBe("1.0 km");
      expect(formatDistance(999.4)).toBe("999 m");
      // ~999.6 m due north
      const near = describeTarget({ lat: 45, lon: 7 }, { lat: 45 + 999.6 / 111194.927, lon: 7 });
      expect(near?.label).toBe("1.0 km N");
      expect(near?.description).toBe("1.0 chilometri, direzione geografica verso nord");
    });

    it("the description uses the singular for one metre", () => {
      expect(describeTarget({ lat: 45, lon: 7 }, { lat: 45 + 1 / 111194.927, lon: 7 })?.description).toBe("1 metro");
    });

    it("withDirection: false keeps only the distance (stale position)", () => {
      const result = describeTarget({ lat: 45, lon: 7 }, { lat: 45.003, lon: 7.004 }, { withDirection: false });
      expect(result?.label).toBe("458 m");
      expect(result?.description).toBe("458 metri");
      expect(result?.compass).toBeUndefined();
    });

    it("gives a spelled-out description for tooltips and screen readers, always saying it is a geographic direction", () => {
      expect(describeTarget({ lat: 45, lon: 7 }, { lat: 45.003, lon: 7.004 })?.description).toBe("458 metri, direzione geografica verso nord-est");
      expect(describeTarget({ lat: 45, lon: 7 }, { lat: 46, lon: 7 })?.description).toBe("111.2 chilometri, direzione geografica verso nord");
    });

    it("the same point is '0 m' with no direction", () => {
      expect(describeTarget({ lat: 45, lon: 7 }, { lat: 45, lon: 7 })?.label).toBe("0 m");
    });

    it("is undefined — so a UI shows no tag — when either point is missing or invalid", () => {
      expect(describeTarget({ lat: 45, lon: 7 }, { lat: undefined, lon: undefined } as never)).toBeUndefined();
      expect(describeTarget(undefined as never, { lat: 45, lon: 7 })).toBeUndefined();
    });
  });
});
