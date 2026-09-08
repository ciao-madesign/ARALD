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

`images/` is currently empty. Sections that expect a photo are marked in the code with `data-placeholder-image="..."` (in `index.html`) and a `/* PLACEHOLDER */` comment above the matching CSS rule (in `styles.css`) — until real photos are added, those spots render a topographic pattern derived from the "Waypoint" palette, not a blank box.

Expected files, once available (any of these can be swapped in independently — nothing else needs to change):

| File | Used for | Suggested aspect ratio |
|---|---|---|
| `images/hero.jpg` | Hero background (behind the headline) | wide, e.g. 1920×1080 |
| `images/scenario-alpine.jpg` | "Mountain shelters" card | 4:3 |
| `images/scenario-emergency.jpg` | "Emergency & disaster response" card | 4:3 |
| `images/scenario-humanitarian.jpg` | "NGOs & humanitarian operations" card | 4:3 |

To wire one in, add the file here and set the corresponding CSS rule's `background-image` (see the `/* PLACEHOLDER */` comments in `styles.css` — `.hero-bg-photo` and `.scenario-photo`) to `url("images/<file>.jpg"); background-size: cover; background-position: center;`.

## Fonts

`fonts/` holds the same self-hosted Overpass/Fraunces subset already used by `mobile/www/` (Waypoint identity) — copied here so the site works with no external font requests, consistent with the project's "no internet dependency" principle even for its own marketing page.
