import { afterEach, describe, expect, it } from "vitest";
import { NomadNode } from "../../node/src/node.js";
import { WebUiServer } from "../../node/src/web-ui.js";

/**
 * `WebUiServer`'s `GET`/`POST /api/emergency-beacons` (`WebUiOptions.exposeEmergencyBeacons`,
 * `docs/beacon.md` "Cosa manca davvero" #3, the Emergency Node view). Unit-
 * level payload validation/storage is covered in
 * `tests/unit/emergency-beacon.test.ts`; the broadcast delivery path in
 * `tests/integration/emergency-beacon.test.ts` — this file exercises only
 * the HTTP surface, both read and write.
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

  it("POST /api/emergency-beacons 404s when allowServiceCalls is off, even with exposeEmergencyBeacons/networkPassword set", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, exposeEmergencyBeacons: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: "aiuto" }),
    });
    expect(res.status).toBe(404);
    expect(node.emergencyBeacons.list()).toEqual([]);
  });

  it("POST /api/emergency-beacons works independently of exposeEmergencyBeacons (a guest phone raising its own SOS is not an operator-only capability — voce #107)", async () => {
    node = new NomadNode({ displayName: "N" });
    // exposeEmergencyBeacons deliberately omitted/false here — the write path must not depend on it.
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const noAuth = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: "aiuto", lat: 45.1, lon: 9.1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.beaconContentId).toBe("string");

    const sightings = node.emergencyBeacons.list();
    expect(sightings).toHaveLength(1);
    expect(sightings[0]).toMatchObject({ beaconContentId: body.beaconContentId, deviceId: node.nodeId, message: "aiuto" });
  });

  it("POST /api/emergency-beacons rejects an invalid field with 400 and the underlying validation message, never recording a sighting", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const res = await fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ lat: 999 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/'lat'/);
    expect(node.emergencyBeacons.list()).toEqual([]);
  });

  it("POST /api/emergency-beacons surfaces the anti-flood budget as 429 once exhausted", async () => {
    node = new NomadNode({ displayName: "N" });
    webUi = new WebUiServer(node, { port: 0, allowServiceCalls: true, networkPassword: TOKEN });
    await webUi.start();

    const post = () =>
      fetch(`http://127.0.0.1:${webUi.port}/api/emergency-beacons`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ message: "aiuto" }),
      });

    // MAX_EMERGENCY_BEACON_PER_WINDOW (node.ts) is 3 — the first three must succeed, the fourth trips it.
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/too many emergency beacons/);
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
