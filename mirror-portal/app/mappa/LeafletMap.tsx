"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect } from "react";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import type { MapPoint } from "../../lib/map-points";

// OpenTopoMap (topographic styling — a good fit for a mountain-rescue context) is a free, public tile
// service that doesn't require an account/API key, same provider already used for this reason on the
// product owner's other project. Honest limit, same posture already applied elsewhere in this
// codebase for anything not independently verifiable from this environment: this session has no live
// internet access to re-check OpenTopoMap's current usage policy/rate limits itself — if this portal's
// real traffic ever grows well beyond a handful of operators, that should be revisited (a paid/
// self-hosted tile source, or an API-key provider), not assumed to keep working at any scale forever.
const TILE_URL = "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
  '<a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; ' +
  '<a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';

const DEFAULT_CENTER: [number, number] = [42.5, 12.5]; // roughly the center of Italy — only used when there is nothing to fit bounds to
const DEFAULT_ZOOM = 6;

const LEGEND_ITEMS: Array<{ kind: MapPoint["kind"] | "relay-off-outline"; label: string; color: string; outline?: boolean }> = [
  { kind: "sos", label: "SOS", color: "var(--sos)" },
  { kind: "emergency", label: "Drop (emergenza)", color: "var(--sos)" },
  { kind: "hazard", label: "Hazard", color: "var(--hazard)" },
  { kind: "info", label: "Info", color: "var(--info)" },
  { kind: "relay-on", label: "Relay online", color: "var(--relay)" },
  { kind: "relay-off-outline", label: "Relay offline", color: "#fff", outline: true },
];

/** One `divIcon` per point kind — plain HTML/CSS (globals.css's `.map-pin*` rules), no image assets, so this never depends on Leaflet's own default marker PNGs (which need extra bundler config to resolve correctly in Next.js). */
function buildIcon(kind: MapPoint["kind"]): L.DivIcon {
  const headIcon = iconSvgFor(kind);
  if (kind === "sos") {
    return L.divIcon({
      className: "",
      html: `<div class="map-pin sos"><div class="map-pin-pulse"></div><div class="map-pin-head">${headIcon}</div><div class="map-pin-stem"></div></div>`,
      iconSize: [32, 38],
      iconAnchor: [16, 38],
      popupAnchor: [0, -36],
    });
  }
  return L.divIcon({
    className: "",
    html: `<div class="map-pin ${kind}"><div class="map-pin-head">${headIcon}</div><div class="map-pin-stem"></div></div>`,
    iconSize: [26, 31],
    iconAnchor: [13, 31],
    popupAnchor: [0, -29],
  });
}

function iconSvgFor(kind: MapPoint["kind"]): string {
  const stroke = kind === "relay-off" ? "var(--relay)" : "#fff";
  switch (kind) {
    case "sos":
    case "emergency":
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.4"><line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="17" r="0.9" fill="${stroke}" stroke="none"/></svg>`;
    case "hazard":
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2"><path d="M12 4 3 19h18z"/><line x1="12" y1="10" x2="12" y2="14"/></svg>`;
    case "info":
      return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.4"><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="8" r="0.6" fill="${stroke}" stroke="none"/></svg>`;
    case "relay-on":
    case "relay-off":
      return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2"><line x1="12" y1="21" x2="12" y2="10"/><path d="M8 10a4 4 0 0 1 8 0"/><path d="M5.5 10a6.5 6.5 0 0 1 13 0"/></svg>`;
  }
}

const ICON_CACHE = new Map<MapPoint["kind"], L.DivIcon>();
function iconFor(kind: MapPoint["kind"]): L.DivIcon {
  let icon = ICON_CACHE.get(kind);
  if (!icon) {
    icon = buildIcon(kind);
    ICON_CACHE.set(kind, icon);
  }
  return icon;
}

/** Fits the view to every point once, on mount/whenever the point set changes — a plain `useMap()` child rather than a `MapContainer` prop, since react-leaflet only reads `bounds` once at construction, not reactively. */
function FitBounds({ points }: { points: MapPoint[] }): null {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lon], 13);
      return;
    }
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40] });
  }, [map, points]);
  return null;
}

export function LeafletMap({ points }: { points: MapPoint[] }): JSX.Element {
  return (
    <>
      <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom style={{ width: "100%", height: "100%" }}>
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={17} />
        <FitBounds points={points} />
        {points.map((p) => (
          <Marker key={p.id} position={[p.lat, p.lon]} icon={iconFor(p.kind)}>
            <Popup>
              <p className="map-popup-title">{p.title}</p>
              <p className="map-popup-meta mono">{p.meta}</p>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      {points.length > 0 && (
        <div className="map-legend">
          <div className="map-legend-title">Legenda</div>
          {LEGEND_ITEMS.map((item) => (
            <div className="map-legend-item" key={item.kind}>
              <span
                className="map-legend-dot"
                style={item.outline ? { background: "#fff", borderColor: "var(--relay)" } : { background: item.color }}
              />
              {item.label}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
