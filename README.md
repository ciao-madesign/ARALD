# ARALD

A distributed, content-centric, delay-tolerant network for emergencies, mountain shelters, and environments without connectivity.

ARALD lets mobile devices and edge nodes share communications, content, and services without any Internet infrastructure — local mesh networks, store-and-forward, opportunistic caching, distributed replication, and intermittent Internet gateways — syncing automatically once an external connection becomes available.

```
GET content://wikipedia/italy
```

Users never need to know which device holds a piece of content, how many hops away it is, or whether it's reachable right now: the network figures that out on its own.

The name comes from *araldo* — a herald, the messenger who carries word to the next stop — a fitting image for a store-and-forward network where every node can end up carrying a message further along.

## Documentation

- [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) — full design specification (single source of truth)
- [`docs/reuse-vs-new.md`](docs/reuse-vs-new.md) — what's reused from Project NOMAD / BitChat / other prior art, with license review, and what's built from scratch
- [`docs/architecture.md`](docs/architecture.md) — layered architecture, component roles
- [`docs/protocol.md`](docs/protocol.md) — packet format, message types, content IDs
- [`docs/transport.md`](docs/transport.md) — transport abstraction, TCP/BLE/LoRa, iOS/Android constraints
- [`docs/security.md`](docs/security.md) — identity, content integrity, what's still missing
- [`docs/development.md`](docs/development.md) — how to build, run, and test
- [`docs/deployment.md`](docs/deployment.md) — target deployment scenarios (mountain shelter, emergency)
- [`docs/beacon.md`](docs/beacon.md) — the ARALD Card: a single radio device (credit-card form factor) that unifies Beacon and Emergency Relay roles into three firmware profiles (Beacon/Relay/Beacon+Relay Mode), plus Fixed Relay/Relay Registry and a note on EU regulatory compliance (RED, ETSI EN 300 328/300 220, CE) for a possible future commercial release — the **physical device** remains a proposal (no hardware built), but the **network logic** behind all three profiles is implemented and tested (`docs/security.md` entries #54-56: Relay Registry, courier profile, Beacon SOS)
- [`docs/emergency-rescue-network.md`](docs/emergency-rescue-network.md) — ARALD Emergency & Rescue Network: a phased validation roadmap (prototype, micro pilot, field pilot), network-effect/density considerations and participation levels, and possible field partners for the Beacon/Relay ecosystem — reference documentation, no code or hardware
- [`docs/test-protocol.md`](docs/test-protocol.md) — a technical test/validation protocol across phases 0-8 (Box/Portable/Card/Smartphone progression, numbered tests, KPIs, PASS/CONDITIONAL/FAIL criteria) — a complementary axis to `emergency-rescue-network.md` (technical scale here, budget/partners there), reference documentation
- [`docs/emergency-portal.md`](docs/emergency-portal.md) — architecture for a web **Emergency Portal**: the operator dashboard runs locally on the ARALD Box/PC+Portable itself (LAN-only, no Internet dependency), with an Internet-hosted mirror (Vercel + Neon) for ordinary remote management — evaluated against the mesh mechanisms that already exist. Two real pieces built so far: `arald-backend/`, a one-shot sync script verified against a live Postgres database on Neon (Box → mirror), and `local-portal/`, a static server that serves the existing `mobile/www/` dashboard directly from the Box over the LAN, pre-configured to pair with the node automatically
- [`docs/roadmap.md`](docs/roadmap.md) — milestone status
- [`docs/next-steps.md`](docs/next-steps.md) — concrete action plans for candidate next-step milestones
- [`docs/audit-report.html`](docs/audit-report.html) — a plain-language project verification report (tests, security, next steps), updated with every new pass
- [`docs/due-diligence-naming-2026-09-04.md`](docs/due-diligence-naming-2026-09-04.md) — the naming/licensing/trademark due-diligence report behind the "Nomad-Net" → "ARALD" rename (in Italian)

## About the name

This project was previously developed under the working name "Nomad-Net". It has no connection to, and is not affiliated with, endorsed by, or sponsored by:

- **[Project N.O.M.A.D.](https://github.com/Crosstalk-Solutions/project-nomad)** (Crosstalk Solutions LLC, Apache-2.0) — an offline-first knowledge/education server. ARALD's `gateway/nomad/` module can optionally talk to a Project NOMAD instance over plain HTTP (Kiwix, Ollama, and similar services it can expose), the same way it can talk to any other locally reachable service — no Project NOMAD source code is included in or derived from this repository.
- **[NomadNet](https://github.com/markqvist/NomadNet)** (Mark Qvist, GPL-3.0), built on **[Reticulum](https://github.com/markqvist/Reticulum)** and **[LXMF](https://github.com/markqvist/LXMF)** (Mark Qvist, modified MIT) — an off-grid encrypted mesh communications platform. No code from any of these three projects is used here; see [`docs/reuse-vs-new.md`](docs/reuse-vs-new.md) for the full review.

See [`docs/reuse-vs-new.md`](docs/reuse-vs-new.md) for the complete third-party review: what's reused (with attribution and license), what's mocked/interfaced against, and what's original to this project.

## Project status

A software prototype with roadmap Milestones 0-7, 12, 13, 15, 16, 20 complete: per-node cryptographic identity, a packet protocol with TTL and deduplication, TCP transport, multi-hop routing (controlled flooding plus distance-vector cost-based routing for unicast traffic), content discovery and caching, store-and-forward, catalog sync between reconnected network segments, content signing, trust levels, rate limiting, end-to-end encryption for private messages, battery/charge-aware relay policy, and a scale simulator — all demonstrated on a real local network (TCP), no Internet required.

Following a full technical audit (see [`docs/audit-report.html`](docs/audit-report.html)), a long series of features were added — full detail in [`docs/security.md`](docs/security.md): content-provider retry, a shared bounded data structure, trust-weighted eviction, real priority-based scheduling, `CONTENT_NOT_FOUND` + content expiry, service discovery, a local web status/search interface (`node/src/web-ui.ts`), a **simulated** BLE transport (no real radio), a **mocked** third-party gateway with sub-services for Kiwix search, a local AI model, and a news feed (against local fake servers), a **mobile app** (`mobile/`, Capacitor) pairing with a gateway Wi-Fi-style (network name + password, also via QR code), and a search-engine-style mobile dashboard with quick links to available services. Everything is covered by repeated automated tests and multiple code-review passes (real bugs found and fixed at every step, documented in `docs/security.md`).

**What's still blocked**: the **real hardware/Docker** versions of BLE and the third-party gateway (these need, respectively, physical BLE hardware and Docker plus a reachable Project NOMAD instance) — their simulated/mocked counterparts above have already validated all the application logic in pure software. **Proposed hardware expansions, never built**: the ARALD Box/Portable (`docs/deployment.md`, no code) and the ARALD Card (`docs/beacon.md`, a single radio device unifying Beacon Mode/Relay Mode/Beacon+Relay Mode into one hardware architecture, plus Fixed Relay/Relay Registry) — for the latter, unlike Box/Portable, the **network logic is already implemented and tested** in pure software (`node/src/relay-registry.ts`, `emergency-beacon.ts`, `transports/beacon-broadcast.ts`, changes to `store-and-forward.ts` — `docs/security.md` entries #54-56): only the physical device itself (PCB, firmware, enclosure) remains unbuilt, unavailable in this environment. **Mobile UI design debt: addressed** — a full rebrand pass ("Waypoint" visual identity, topographic palette, mark, components) plus a dedicated UX pass for a general, non-technical audience have already shipped (see `docs/security.md` entries #28-31 and #48); only a possible future visual refresh remains noted, not yet planned in detail. See [`docs/roadmap.md`](docs/roadmap.md) for the detailed status of every milestone and [`docs/next-steps.md`](docs/next-steps.md) for action plans.

## Quick start

```bash
npm install
npm test
```

Start a node:

```bash
npm run dev -w node -- --id A --port 9001
```

See [`docs/development.md`](docs/development.md) for the full workflow (multi-node, build, test).

## Repository structure

```
arald/
├─ docs/            specification and technical documentation
├─ protocol/        shared protocol definitions — placeholder, no real code yet
├─ node/            the ARALD node runtime (identity, routing, content, transport, web UI) — the only package in the npm workspace
├─ gateway/nomad/   ARALD <-> Project NOMAD translation layer (Kiwix/Ollama/news) — mocked against local fake servers, a separate project
├─ mobile/          Capacitor app talking to a gateway (Wi-Fi/TCP, Step 1) — verified via browser; native Android build doesn't compile in this environment; iOS still a placeholder
├─ tests/           unit, integration, network
└─ tools/           network simulator (tools/simulator/)
```

Full reference structure: [`docs/SPECIFICATION.md` §87](docs/SPECIFICATION.md#87-struttura-della-repository-finale).

## Key references

- Project N.O.M.A.D. — https://github.com/Crosstalk-Solutions/project-nomad (Apache-2.0; optional local service ARALD's gateway can talk to over HTTP — no code reused)
- NomadNet / Reticulum / LXMF — https://github.com/markqvist/NomadNet, https://github.com/markqvist/Reticulum, https://github.com/markqvist/LXMF (GPL-3.0 / modified MIT; reviewed as prior art in the same problem space — no code reused, see `docs/reuse-vs-new.md`)
- BitChat — https://github.com/permissionlesstech/bitchat ([whitepaper](https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md)) (Unlicense; the "board" concept behind `node/src/drops.ts` is credited to BitChat's `BoardManager` — no code reused, see `docs/reuse-vs-new.md`)
- Apple Core Bluetooth — https://developer.apple.com/documentation/corebluetooth
- Android Bluetooth permissions — https://developer.android.com/develop/connectivity/bluetooth/bt-permissions

## License

[MIT](LICENSE)
