# ARALD public site

A static site — plain HTML/CSS/JS, no build step, no framework. Separate from the rest of the repository (like `mobile/`, `mirror-portal/`, etc.): not part of the root npm workspace.

Four pages, kept deliberately separate so the landing page stays short and visual — deep-dive content lives one click away, not stacked on the homepage:

- `index.html` — the landing page: hero, a one-request example, the three primary scenarios (photo cards), a device strip, an "open project" section, status stats, CTA.
- `overview.html` — "Where it works": the full gallery of all ten scenarios (the three primary ones plus seven more), each with a photo and a short description.
- `how-it-works.html` — the mechanism (three steps), the full device family (five cards), and the honest "what's real today" status detail.
- `contribute.html` — "Get involved": contributing code (GitHub, MIT license), and the hardware round (three device tiers with BOMs, why LoRa/BLE/Wi-Fi are all part of the architecture, contribution priorities, what a contribution funds).

## Preview locally

```bash
cd site
npx serve .
# or: python3 -m http.server 8000
```

Open the printed URL in a browser.

## Deploy to Vercel

Same pattern already used for `mirror-portal/`: create a new Vercel project pointing at this repository, with **Root Directory** set to `site`. No framework preset needed (or "Other" — it's static files, Vercel serves them as-is). No environment variables required.

## Where images go

All real photos live in `img/` (not `images/`). Attribution for every photo in use is tracked in [`img/CREDITS.md`](img/CREDITS.md) — add a line there for every new photo (source, photographer, license).

Every scenario/hero slot is filled — no CSS placeholders left:

| File | Used for |
|---|---|
| `img/hero.jpg` | Landing page hero background |
| `img/scenario-alpine.jpg` | "Mountain shelters" (primary) |
| `img/scenario-emergency.jpg` | "Emergency & disaster response" (primary) |
| `img/scenario-humanitarian.jpg` | "NGOs & humanitarian operations" (primary) |
| `img/scenario-ships.jpg` | "Ships, coasts & islands" |
| `img/scenario-expeditions.jpg` | "Expeditions & remote stations" |
| `img/scenario-rural.jpg` | "Rural & isolated communities" |
| `img/scenario-forests.jpg` | "Forests & nature reserves" |
| `img/scenario-events.jpg` | "Crowded events" |
| `img/scenario-schools.jpg` | "Schools" |
| `img/scenario-crisis.jpg` | "Temporary & crisis infrastructure" |
| `img/community.jpg` | "An open project" section (index.html) |
| `img/where-it-works.jpg` | Page banner on `overview.html` |
| `img/mechanism.jpg` | Page banner on `how-it-works.html` |
| `img/hardware.jpg` | Page banner on `contribute.html` |

"Deserts" was considered and dropped — no photo, not pursued further (explicit decision).

Before adding or replacing a photo, resize/compress it for web first (originals straight off Unsplash run 3-6MB at 5000+px wide) — e.g. with `sharp` (`npx sharp-cli resize 1600 -- input.jpg -o img/output.jpg -q 78`) or any equivalent tool. Target: max ~1200-1600px on the long edge (2400px for the hero, it's full-bleed), JPEG quality ~75-80, well under 300KB.

## Fonts

`fonts/` holds the same self-hosted Overpass/Fraunces subset already used by `mobile/www/` (Waypoint identity) — copied here so the site works with no external font requests, consistent with the project's "no internet dependency" principle even for its own marketing page.
