import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";

/**
 * `WebUiServer`'s `GET /api/emergency-beacons` (`WebUiOptions.exposeEmergencyBeacons`,
 * `docs/beacon.md` "Cosa manca davvero" #3, the Emergency Node view). Unit-
 * level payload validation/storage is covered in
 * `tests/unit/emergency-beacon.test.ts`; the broadcast delivery path in
 * `tests/integration/emergency-beacon.test.ts` — this file exercises only
 * the HTTP read surface.
 */
describe("WebUiServer emergency beacon endpoint", () => {
  const TOKEN = "K7XM-2QRT";
  let node: NomadNode | undefined;
  let webUi: WebUiServer | undefined;

  afterEach(async () => {
    if (webUi) await webUi.stop();
    if (node) await node.stop();
    node = undefined;
    webUi = undefined;
  });

  it("constructing with exposeEmergencyBeacons but no networkPassword throws immediately", () => {
    const n = new NomadNode({ displayName: "N" });
    expect(() => new WebUiServer(n, { port: 0, exposeEmergencyBeacons: true })).toThrow(/networkPassword/);
  });

  it("GET /api/emergency-beacons 404s when exposeEmergencyBeacons is off, even with allowServiceCalls/networkPassword set", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("requires the network password and lists known sightings", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeEmergencyBeacons: true, networkPassword: TOKEN });
    await webUi.start();

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`);
    expect(noAuth.status).toBe(401);

    const empty = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await empty.json()).toEqual([]);

    const sighting = node.sendEmergencyBeacon({ message: "aiuto", lat: 45.1, lon: 9.1 });
    const withOne = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await withOne.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ beaconContentId: sighting.beaconContentId, deviceId: node.nodeId, message: "aiuto" });
  });

  it("has no POST endpoint — a SOS only ever arrives from the mesh, never from an HTTP client", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeEmergencyBeacons: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: "fabricated" }),
    });
    expect(res.status).not.toBe(200); // never accepted — the path only ever has a GET handler registered
    expect(node.emergencyBeacons.list()).toEqual([]); // and certainly never recorded as a real sighting
  });

  it("exposeEmergencyBeacons alone (allowServiceCalls off) still gets CORS headers on its endpoint", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeEmergencyBeacons: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
  });
});
