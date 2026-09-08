# ARALD

**A network that works where the internet doesn't.**

ARALD lets phones, small radio devices, and local computers share content, messages, and services directly with each other — no cell towers, no Wi-Fi router, no satellite link. Requests hop from device to device until they reach an answer, and sync automatically the moment a connection becomes available.

```
GET content://wikipedia/italy
```

You never need to know which device holds a piece of content, how many hops away it is, or whether it's reachable right now — the network figures that out on its own.

New here? Start with **[What ARALD Is, and Why](docs/overview.md)** and **[How ARALD Works](docs/how-it-works.md)** — five minutes, no technical background needed.

## Where it works

Three environments have driven ARALD's design so far — equally important, not a hierarchy:

- **⛰️ Mountain shelters and remote huts**
- **🚨 Emergency and disaster response**
- **🤝 NGOs and humanitarian operations**

The same architecture applies without changes anywhere reliable connectivity can't be assumed: ships and islands, expeditions, rural communities, forests, deserts, crowded events, schools, and temporary or crisis infrastructure. See [`docs/overview.md`](docs/overview.md) for the full list and [`docs/deployment.md`](docs/deployment.md) for concrete deployment scenarios.

## Project status

A working software prototype, not a mockup: core networking (identity, routing, encryption, store-and-forward, content caching) runs today over real local networks and is covered by automated tests. Radio transports and higher-level features (chat, an SOS beacon, local search/AI services) are built and tested in software; the physical radio devices (ARALD Card/Relay) haven't been manufactured yet. See [How ARALD Works](docs/how-it-works.md#whats-real-today) for the plain-language summary, or [`docs/roadmap.md`](docs/roadmap.md) for full technical milestone tracking.

## Documentation

**Start here, no code required:**

- [`docs/overview.md`](docs/overview.md) — what ARALD is, why it exists, where it's used.
- [`docs/how-it-works.md`](docs/how-it-works.md) — the mechanism, the device family, current status.

**Technical documentation** (for contributors and developers):

- [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) — full design specification (single source of truth)
- [`docs/architecture.md`](docs/architecture.md) — layered architecture, component roles
- [`docs/protocol.md`](docs/protocol.md) — packet format, message types, content IDs
- [`docs/transport.md`](docs/transport.md) — transport abstraction, TCP/BLE/LoRa, iOS/Android constraints
- [`docs/security.md`](docs/security.md) — identity, content integrity, full feature-by-feature build history
- [`docs/development.md`](docs/development.md) — how to build, run, and test
- [`docs/deployment.md`](docs/deployment.md) — deployment scenarios: mountain shelter, emergency/disaster response, NGO/humanitarian operations, plus events, schools, and expeditions
- [`docs/beacon.md`](docs/beacon.md) — the ARALD Card, Fixed Relay, and Relay Registry: device design and the network logic behind them (implemented and tested; physical hardware not yet built)
- [`docs/emergency-rescue-network.md`](docs/emergency-rescue-network.md) — phased field-validation roadmap, network-effect considerations, possible field partners
- [`docs/test-protocol.md`](docs/test-protocol.md) — technical test/validation protocol across phases 0-8
- [`docs/emergency-portal.md`](docs/emergency-portal.md) — the Emergency Portal: a local operator dashboard with a read-only internet-hosted mirror for remote management
- [`docs/roadmap.md`](docs/roadmap.md) — milestone status
- [`docs/next-steps.md`](docs/next-steps.md) — open candidates for future work
- [`docs/reuse-vs-new.md`](docs/reuse-vs-new.md) — what's reused from prior art (with license review) vs. built from scratch
- [`docs/due-diligence-naming-2026-09-04.md`](docs/due-diligence-naming-2026-09-04.md) — the naming/licensing/trademark review behind the "Nomad-Net" → "ARALD" rename (in Italian)

## About the name

This project was previously developed under the working name "Nomad-Net". It has no connection to, and is not affiliated with, endorsed by, or sponsored by:

- **[Project N.O.M.A.D.](https://github.com/Crosstalk-Solutions/project-nomad)** (Crosstalk Solutions LLC, Apache-2.0) — an offline-first knowledge/education server. ARALD's `gateway/nomad/` module can optionally talk to a Project NOMAD instance over plain HTTP (Kiwix, Ollama, and similar services it can expose), the same way it can talk to any other locally reachable service — no Project NOMAD source code is included in or derived from this repository.
- **[NomadNet](https://github.com/markqvist/NomadNet)** (Mark Qvist, GPL-3.0), built on **[Reticulum](https://github.com/markqvist/Reticulum)** and **[LXMF](https://github.com/markqvist/LXMF)** (Mark Qvist, modified MIT) — an off-grid encrypted mesh communications platform. No code from any of these three projects is used here; see [`docs/reuse-vs-new.md`](docs/reuse-vs-new.md) for the full review.

The name comes from *araldo* — a herald, the messenger who carries word to the next stop, a fitting image for a store-and-forward network where every node can end up carrying a message further along.

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
├─ nomad-hub/       Management API that administers Docker on whatever host runs Project NOMAD — a separate project, never the mesh
├─ mobile/          Capacitor app talking to a gateway (Wi-Fi/TCP, Step 1) — verified via browser; native Android build doesn't compile in this environment; iOS still a placeholder
├─ arald-backend/   one-shot sync script from a Box's local endpoints to a Postgres mirror (Neon) — a separate project
├─ local-portal/    serves the mobile/www/ dashboard directly from a Box over the LAN, pre-paired — a separate project
├─ mirror-portal/   read-only Next.js app reading the Postgres mirror — a separate project
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
