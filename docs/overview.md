# What ARALD Is, and Why

Most communication tools assume you have internet. ARALD doesn't.

It's a network that works **without any internet connection at all** — devices pass content, messages, and services directly to each other, hopping from one device to the next until they reach whoever needs them. No cell towers, no Wi-Fi router, no satellite link required.

## The idea in one example

Imagine you're at a mountain hut with no signal. Someone at the hut has a local copy of Wikipedia. You want to read the article on Italy.

```
GET content://wikipedia/italy
```

You don't need to know which device has that article, how many other devices it has to pass through to reach you, or whether the source is even reachable right now. You ask for the content; the network finds a path and delivers it — the same way a letter reaches you without you knowing which trucks and sorting offices it passed through.

If nobody nearby has it yet, your request waits. The next time your device meets one that has an answer — a phone walking by, a relay a village over — it gets delivered. Nothing needs to be online all at once.

## Where it's built for

Three environments have driven ARALD's design so far — equally important, not a hierarchy:

- **⛰️ Mountain shelters and remote huts** — where cell coverage never arrives and running a cable isn't an option.
- **🚨 Emergency and disaster response** — earthquakes, floods, fires: exactly when normal networks are damaged, overloaded, or without power.
- **🤝 NGOs and humanitarian operations** — field bases, mobile clinics, and temporary camps in areas without reliable infrastructure.

The same architecture — small radio devices, relays, and gateway nodes — applies without changes to other places where connectivity can't be assumed:

- Ships, coastlines, and islands
- Expeditions and remote scientific stations
- Rural and isolated communities
- Forests and large natural areas
- Deserts and other sparsely connected regions
- Crowded events, where the mesh multiplies reach instead of replacing it
- Schools relying on a static local library instead of live internet
- Temporary or crisis infrastructure — construction sites, relief camps, ad hoc deployments

If a place has *no*, *intermittent*, *expensive*, or *unreliable* connectivity, it's a candidate for ARALD.

## Next

- [How ARALD works](how-it-works.md) — the mechanism, the devices, and what's real today.
- [`docs/deployment.md`](deployment.md) — detailed deployment scenarios and hardware.
- [`README.md`](../README.md) — quick start for developers.
