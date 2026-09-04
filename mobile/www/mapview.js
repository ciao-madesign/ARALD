/**
 * Minimal raster slippy-map viewer, written from scratch — no map library (Leaflet, MapLibre, ...):
 * this sandbox has no real internet access to fetch/vendor one, and mobile/www/ has never carried a
 * third-party runtime dependency besides @capacitor/geolocation (unavoidable hardware access) — see
 * docs/next-steps.md for the full discussion. Scope is deliberately narrow: pan (drag), zoom (buttons
 * + wheel), "center on my location" — no rotation, no vector overlays, no offline-region picker (a
 * gateway serves exactly one pre-baked MBTiles region, node/src/map-tiles.ts).
 *
 * Tiles come from GET /api/map-tiles/:z/:x/:y (unauthenticated, node/src/web-ui.ts) — plain <img>
 * elements positioned in world-pixel space, standard Web Mercator/"XYZ" tile math (same convention
 * as every other slippy map; node/src/map-tiles.ts flips MBTiles' own TMS row order to match this on
 * the server side, once, so nothing here needs to know MBTiles' on-disk convention at all).
 */

const TILE_SIZE = 256;

let mapInfo = null; // last GET /api/map-info result this device has seen, or null if never offered
let mapState = null; // { zoom, centerPx: {x,y} } while the overlay is open; null otherwise

function lonLatToWorldPx(lon, lat, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return { x, y };
}

function worldPxToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

// A real raster tile set never goes anywhere near this deep (z22 is already sub-centimeter
// resolution) — this is a hard ceiling independent of whatever GET /api/map-info reports, found by
// review: mapInfo.maxzoom comes straight from the MBTiles file's own metadata table
// (node/src/map-tiles.ts), unauthenticated and served verbatim over plain HTTP, so an unusually
// large/malformed value there (a bad file, a compromised gateway, an on-path LAN attacker) must
// never be trusted as the client's own zoom ceiling. Without this, letting zoom climb high enough
// makes Math.pow(2, zoom) overflow to Infinity, and renderMapTiles()'s tile loop
// (`for (let tx = firstTileX; tx <= lastTileX; tx++)`) never terminates once its bounds are both
// Infinity — the same overflow class node/src/web-ui.ts's own z<=30 server-side cap exists to
// prevent, just needed here too since the client does its own independent zoom math.
const ABSOLUTE_MAX_ZOOM = 22;

function clampZoom(zoom) {
  const min = mapInfo && mapInfo.minzoom !== undefined ? mapInfo.minzoom : 0;
  const max = Math.min(mapInfo && mapInfo.maxzoom !== undefined ? mapInfo.maxzoom : 19, ABSOLUTE_MAX_ZOOM);
  return Math.max(min, Math.min(max, zoom));
}

/** Top-left corner of the viewport, in world-pixel space, for a given center/zoom — the one quantity both renderMapTiles() and the live drag transform (moveDrag()) need to agree on. */
function topLeftWorldPx(centerPx, viewport) {
  return { x: centerPx.x - viewport.clientWidth / 2, y: centerPx.y - viewport.clientHeight / 2 };
}

/**
 * GET /api/map-info (node/src/web-ui.ts) — `null` when this gateway doesn't offer map tiles (404,
 * same graceful-degradation posture as fetchLocationRegistry() for /api/location-registry). Never
 * authenticated — see WebUiOptions.mapTiles's own doc comment for why.
 */
async function fetchMapInfo() {
  const res = await fetchWithTimeout(apiUrl("/api/map-info"), undefined, READ_TIMEOUT_MS);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/** Shows/hides #map-panel's "Apri mappa" button based on the latest fetchMapInfo() result — called every refreshAll() cycle, same as renderLocationReports(). */
function renderMapAvailability(info) {
  mapInfo = info;
  document.getElementById("map-panel").hidden = info === null;
}

/**
 * Rebuilds the visible tile grid for the current mapState. Positions each tile `<img>` at its true
 * world-pixel coordinate (`tileIndex * TILE_SIZE`) and shifts the whole layer with one CSS
 * `transform` so the viewport's top-left corner lands on `topLeftWorldPx()` — the same transform
 * shape `moveDrag()` below adds a live pixel offset to during a drag, so a drag's end state lines up
 * exactly with what a fresh render would have produced.
 */
function renderMapTiles() {
  const layer = document.getElementById("map-tiles-layer");
  const pinsLayer = document.getElementById("map-pins-layer");
  const relaysLayer = document.getElementById("map-relays-layer");
  const beaconsLayer = document.getElementById("map-beacons-layer");
  layer.textContent = "";
  if (!mapState) {
    layer.style.transform = "";
    pinsLayer.style.transform = "";
    relaysLayer.style.transform = "";
    beaconsLayer.style.transform = "";
    renderMapPins();
    renderMapRelays();
    renderMapBeacons();
    return;
  }

  const viewport = document.getElementById("map-viewport");
  const { zoom, centerPx } = mapState;
  const topLeft = topLeftWorldPx(centerPx, viewport);
  const maxTileIndex = Math.pow(2, zoom) - 1;

  layer.style.transform = `translate(${-topLeft.x}px, ${-topLeft.y}px)`;
  pinsLayer.style.transform = layer.style.transform;
  relaysLayer.style.transform = layer.style.transform;
  beaconsLayer.style.transform = layer.style.transform;

  const firstTileX = Math.floor(topLeft.x / TILE_SIZE);
  const firstTileY = Math.floor(topLeft.y / TILE_SIZE);
  const lastTileX = Math.floor((topLeft.x + viewport.clientWidth) / TILE_SIZE);
  const lastTileY = Math.floor((topLeft.y + viewport.clientHeight) / TILE_SIZE);

  for (let tx = firstTileX; tx <= lastTileX; tx++) {
    if (tx < 0 || tx > maxTileIndex) continue;
    for (let ty = firstTileY; ty <= lastTileY; ty++) {
      if (ty < 0 || ty > maxTileIndex) continue;
      const img = document.createElement("img");
      img.alt = "";
      img.style.left = tx * TILE_SIZE + "px";
      img.style.top = ty * TILE_SIZE + "px";
      img.addEventListener("error", () => img.remove(), { once: true }); // missing tile → just leave a gap, never a broken-image icon
      img.src = apiUrl(`/api/map-tiles/${zoom}/${tx}/${ty}`);
      layer.append(img);
    }
  }
  renderMapPins();
  renderMapRelays();
  renderMapBeacons();
}

/**
 * Draws known drops (docs/next-steps.md — bacheca, concept credited to BitChat's BoardManager,
 * Unlicense/public domain) as pins on the map, at the same world-pixel coordinates renderMapTiles()
 * positions tiles at — `knownDrops` is a global populated by app.js's renderDrops() on every
 * refreshAll() cycle, kept in sync independently of whether the map overlay happens to be open.
 * Urgent drops get the same accent color as their #drops list badge (var(--bad)).
 */
function renderMapPins() {
  const layer = document.getElementById("map-pins-layer");
  layer.textContent = "";
  if (!mapState || typeof knownDrops === "undefined") return;
  for (const d of knownDrops) {
    if (typeof d.lat !== "number" || typeof d.lon !== "number") continue;
    const { x, y } = lonLatToWorldPx(d.lon, d.lat, mapState.zoom);
    const pin = document.createElement("div");
    pin.className = "map-pin" + (d.urgent ? " is-urgent" : "");
    pin.style.left = x + "px";
    pin.style.top = y + "px";
    pin.title = d.label || d.text || "";
    pin.innerHTML = `<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><use href="#icon-${d.urgent ? "alert-triangle" : "map-pin"}"></use></svg>`;
    layer.append(pin);
  }
}

/**
 * Draws known relays (`docs/beacon.md` "Fixed Relay e Registro dei relay") as a second, independent
 * pin layer alongside renderMapPins() — same world-pixel positioning, `knownRelays` populated by
 * app.js's renderRelays() on every refreshAll() cycle. A relay currently offline gets a dimmed pin
 * (`.is-offline`) rather than being hidden outright — where it's installed is still useful to know
 * even when it isn't reachable right now.
 */
function renderMapRelays() {
  const layer = document.getElementById("map-relays-layer");
  layer.textContent = "";
  if (!mapState || typeof knownRelays === "undefined") return;
  for (const r of knownRelays) {
    if (typeof r.lat !== "number" || typeof r.lon !== "number") continue;
    const { x, y } = lonLatToWorldPx(r.lon, r.lat, mapState.zoom);
    const pin = document.createElement("div");
    pin.className = "map-pin map-pin-relay" + (r.online ? "" : " is-offline");
    pin.style.left = x + "px";
    pin.style.top = y + "px";
    pin.title = r.operator || r.relayId;
    pin.innerHTML = `<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><use href="#icon-wifi"></use></svg>`;
    layer.append(pin);
  }
}

/**
 * Draws known emergency beacon sightings (`docs/beacon.md`, the Emergency Node view) as a third,
 * independent pin layer — same world-pixel positioning as renderMapPins()/renderMapRelays().
 * `knownBeacons` is populated by app.js's renderEmergencyBeacons() on every refreshAll() cycle, and
 * stays empty (never populated at all) on a gateway without `exposeEmergencyBeacons` on — same
 * graceful-degradation posture already used for `knownRelays`. Not every sighting has a position
 * (`docs/beacon.md`: a pure Beacon Mode device has no GPS of its own) — those without lat/lon simply
 * don't get a pin, same as an un-positioned drop.
 */
function renderMapBeacons() {
  const layer = document.getElementById("map-beacons-layer");
  layer.textContent = "";
  if (!mapState || typeof knownBeacons === "undefined") return;
  for (const b of knownBeacons) {
    if (typeof b.lat !== "number" || typeof b.lon !== "number") continue;
    const { x, y } = lonLatToWorldPx(b.lon, b.lat, mapState.zoom);
    const pin = document.createElement("div");
    pin.className = "map-pin map-pin-beacon";
    pin.style.left = x + "px";
    pin.style.top = y + "px";
    pin.title = b.message || "SOS";
    pin.innerHTML = `<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><use href="#icon-alert-circle"></use></svg>`;
    layer.append(pin);
  }
}

function setZoom(newZoom) {
  if (!mapState) return;
  const { lon, lat } = worldPxToLonLat(mapState.centerPx.x, mapState.centerPx.y, mapState.zoom);
  const zoom = clampZoom(newZoom);
  mapState = { zoom, centerPx: lonLatToWorldPx(lon, lat, zoom) };
  renderMapTiles();
}

function centerOn(lon, lat, zoom) {
  const z = clampZoom(zoom !== undefined ? zoom : mapState ? mapState.zoom : (mapInfo && mapInfo.maxzoom) || 12);
  mapState = { zoom: z, centerPx: lonLatToWorldPx(lon, lat, z) };
  renderMapTiles();
}

function openMapOverlay() {
  if (!mapInfo) return;
  document.getElementById("map-error").hidden = true;
  document.getElementById("map-attribution").textContent = mapInfo.attribution || mapInfo.name || "";
  document.getElementById("map-overlay").hidden = false;

  if (mapInfo.bounds) {
    const [minLon, minLat, maxLon, maxLat] = mapInfo.bounds;
    centerOn((minLon + maxLon) / 2, (minLat + maxLat) / 2, mapInfo.minzoom);
  } else {
    centerOn(0, 0, mapInfo.minzoom);
  }
}

function closeMapOverlay() {
  document.getElementById("map-overlay").hidden = true;
  mapState = null;
}

// ---------- drag panning ----------
//
// A live re-render (tile math + DOM rebuild + new <img> network requests) on every pointermove would
// be both janky and wasteful — instead the whole tile layer is translated via a cheap CSS transform
// while dragging (immediate visual feedback from tiles already on screen), and the actual tile grid
// is only recomputed/rebuilt once, when the drag ends.

let dragState = null;

function startDrag(event) {
  if (!mapState) return;
  const viewport = document.getElementById("map-viewport");
  viewport.classList.add("is-dragging");
  viewport.setPointerCapture(event.pointerId);
  dragState = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, baseCenterPx: mapState.centerPx };
}

function moveDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  const viewport = document.getElementById("map-viewport");
  const topLeft = topLeftWorldPx(dragState.baseCenterPx, viewport);
  const transform = `translate(${-topLeft.x + dx}px, ${-topLeft.y + dy}px)`;
  document.getElementById("map-tiles-layer").style.transform = transform;
  document.getElementById("map-pins-layer").style.transform = transform;
  document.getElementById("map-relays-layer").style.transform = transform;
  document.getElementById("map-beacons-layer").style.transform = transform;
}

function endDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  document.getElementById("map-viewport").classList.remove("is-dragging");
  mapState = { zoom: mapState.zoom, centerPx: { x: dragState.baseCenterPx.x - dx, y: dragState.baseCenterPx.y - dy } };
  dragState = null;
  renderMapTiles();
}

// ---------- wiring ----------

document.getElementById("open-map-button").addEventListener("click", openMapOverlay);
document.getElementById("map-close").addEventListener("click", closeMapOverlay);
document.getElementById("map-zoom-in").addEventListener("click", () => {
  if (mapState) setZoom(mapState.zoom + 1);
});
document.getElementById("map-zoom-out").addEventListener("click", () => {
  if (mapState) setZoom(mapState.zoom - 1);
});
document.getElementById("map-locate").addEventListener("click", async () => {
  if (!mapState) return;
  const errorEl = document.getElementById("map-error");
  errorEl.hidden = true;
  try {
    const { lat, lon } = await getCurrentPosition();
    centerOn(lon, lat, mapState.zoom);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

const mapViewport = document.getElementById("map-viewport");
mapViewport.addEventListener("pointerdown", startDrag);
mapViewport.addEventListener("pointermove", moveDrag);
mapViewport.addEventListener("pointerup", endDrag);
mapViewport.addEventListener("pointercancel", endDrag);
mapViewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (mapState) setZoom(mapState.zoom + (event.deltaY < 0 ? 1 : -1));
  },
  { passive: false },
);
