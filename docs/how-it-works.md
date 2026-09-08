# How ARALD Works

No jargon, just the mechanism — for the full technical version, see [`docs/architecture.md`](architecture.md) and [`docs/SPECIFICATION.md`](SPECIFICATION.md).

## The network has no center

There's no server that everything connects to. Every device — a phone, a small radio card, a fixed relay, a gateway box — is a peer that can hold content, pass it along, and ask for more. When two devices come within range of each other (Bluetooth, a long-range radio, or a plain local Wi-Fi network), they exchange what they know and move on.

This means the network keeps working even when it's split into disconnected pieces, and heals itself the moment two pieces touch again — a phone walking between two valleys, a boat reaching a harbor, a relay coming back online.

## Ask for content, not for a location

Normal networks make you find an address first ("connect to this server"). ARALD content works the other way: you ask for *what* you want, and the network figures out *where* it is.

```
GET content://wikipedia/italy
```

Whichever device answers first — and however many hops away it was — the requester never needs to know. If the same content is asked for again nearby, a device that already has a copy can answer directly, without going back to the original source.

## Nothing needs to happen at once

If no one nearby can answer right now, the request (or a message meant for someone specific) doesn't just fail — it waits. The next device that could carry it forward picks it up on the next contact. This is what lets a single walking hiker, boat, or delivery vehicle carry information between two places that are never connected directly, on its own schedule.

## The device family

The same software runs on very different hardware, matched to what a situation calls for:

| Device | What it does | Needs a phone? |
|---|---|---|
| **ARALD Card** | Pocket-sized radio: sends an SOS, relays other people's messages, or both. | No |
| **ARALD Relay** (fixed or mobile) | Same logic as the Card, installed permanently (solar-powered) or carried along as a "courier". | No |
| **ARALD Box** | A small always-on computer: stores content, runs local services (search, translation, AI), coordinates a site. | No |
| **ARALD Portable** | The same environment as the Box, on a bootable drive — plug it into whatever computer is available. | No |
| Smartphone app | A dashboard onto any of the above: browse content, chat, share your location, call a service. | — |

None of these need internet to talk to each other. A gateway device can *optionally* bridge out to the internet when it's available, purely as a bonus — never a requirement.

## What's real today

This is a working software prototype, not a mockup:

- Core networking — identity, routing, multi-hop delivery, store-and-forward, encrypted messaging, content signing and caching — is implemented and covered by automated tests, running today over real local networks (Wi-Fi/TCP).
- Radio transports (Bluetooth, LoRa) are implemented behind the same interface the real hardware will use — validated today in software simulation, with a first real LoRa driver already written and tested against a faithful hardware emulator.
- Application features on top — 1:1 and group chat, public channels, a community noticeboard, opportunistic location sharing, an emergency SOS beacon, local search and AI services — are built and tested.

**What's still ahead**: the physical devices themselves (Card, Relay hardware) haven't been manufactured yet — the network logic they'll run has already been built and tested in software. Verifying real radio hardware, a full field pilot, and third-party integrations are the next milestones. See [`docs/roadmap.md`](roadmap.md) for the full technical status and [`docs/next-steps.md`](next-steps.md) for what's next.

## Go deeper

- [`docs/architecture.md`](architecture.md) — component-level architecture.
- [`docs/protocol.md`](protocol.md) — packet format and message types.
- [`docs/security.md`](security.md) — identity, encryption, and the full build history.
- [`docs/deployment.md`](deployment.md) / [`docs/beacon.md`](beacon.md) — hardware and deployment detail.
