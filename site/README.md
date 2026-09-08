# ARALD public site

A static landing page — plain HTML/CSS/JS, no build step, no framework. Separate from the rest of the repository (like `mobile/`, `mirror-portal/`, etc.): not part of the root npm workspace.

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

All real photos live in `img/` (not `images/` — kept consistent with the folder the images actually arrive in). Attribution for every photo currently in use is tracked in [`img/CREDITS.md`](img/CREDITS.md) — add a line there for every new photo (source, photographer, license).

**Already in place**, used as small tiles in the "Where it works" section: `img/scenario-ships.jpg`, `img/scenario-events.jpg`, `img/scenario-schools.jpg`, `img/scenario-rural.jpg`.

**Still needed** — sections that expect one of these are marked in the code with `data-placeholder-image="..."` (in `index.html`) and a `/* PLACEHOLDER */` comment above the matching CSS rule (in `styles.css`); until added, those spots render a topographic pattern derived from the "Waypoint" palette, not a blank box:

| File | Used for | Suggested aspect ratio |
|---|---|---|
| `img/hero.jpg` | Hero background (behind the headline) | wide, e.g. 1920×1080 |
| `img/scenario-alpine.jpg` | "Mountain shelters" card | 4:3 |
| `img/scenario-emergency.jpg` | "Emergency & disaster response" card | 4:3 |
| `img/scenario-humanitarian.jpg` | "NGOs & humanitarian operations" card | 4:3 |

To wire one in, add the file here and set the corresponding CSS rule's `background-image` (see the `/* PLACEHOLDER */` comments in `styles.css` — `.hero-bg-photo` and `.scenario-photo`) to `url("img/<file>.jpg"); background-size: cover; background-position: center;`.

Before adding a new photo, resize/compress it for web first (originals straight off Unsplash run 3-6MB at 5000+px wide) — e.g. with `sharp` (`npx sharp-cli resize 1600 -- input.jpg -o img/output.jpg -q 78`) or any equivalent tool. Target: max ~1600px on the long edge, JPEG quality ~75-80, well under 300KB.

## Fonts

`fonts/` holds the same self-hosted Overpass/Fraunces subset already used by `mobile/www/` (Waypoint identity) — copied here so the site works with no external font requests, consistent with the project's "no internet dependency" principle even for its own marketing page.
