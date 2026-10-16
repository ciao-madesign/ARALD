// ARALD GEO CORE, passo 2 (docs/external-inspiration.md, docs/security.md voci #124/#140): la geo-logica
// condivisa dell'app mobile — distanza, direzione geografica verso un punto, etichetta leggibile.
// Prima di questo file la distanza viveva in app.js (haversineDistanceMeters()) e la stringa
// "N m / N,N km" era copiata due volte (bacheca drop e avvistamenti SOS).
//
// Direzione GEOGRAFICA, non radiogoniometria: tutto qui è matematica sulle coordinate GPS note di due
// punti (posizione propria, posizione dichiarata dal bersaglio). Non misura la direzione di arrivo di un
// segnale radio — l'hardware ARALD non ha antenne direzionali — e nessuna UI deve presentarlo come tale
// (avvertenza esplicita della proposta originale, docs/external-inspiration.md). Se la posizione dichiarata
// dal bersaglio è vecchia o sbagliata, anche la direzione lo è.
//
// Stesso algoritmo di riferimento per ogni futura piattaforma (Watch Wear OS/firmware): raggio terrestre
// medio 6371000 m, formula haversine per la distanza, rotta iniziale (forward azimuth) di un cerchio
// massimo per la direzione, gradi in [0, 360) in senso orario dal nord. Un'implementazione indipendente
// in un altro linguaggio deve riprodurre gli stessi risultati (vedi i vettori di test in
// tests/unit/mobile-geo-core.test.ts). Punto cardinale: 8 settori da 45° centrati sui punti cardinali,
// confine esatto arrotondato per eccesso (22.5° → NE, 337.5° → N, `Math.round` su gradi/45 poi modulo 8):
// una porta in un altro linguaggio deve usare lo stesso "half-up", non "half-even".
//
// Scritto come vero modulo ES (stesso bridge-a-`window` di ble-relay.js/sos-queue.js) per essere
// unit-testato sotto vitest; app.js, uno script classico, lo usa solo dentro corpi funzione.

const EARTH_RADIUS_M = 6371000;

/** Sotto questa distanza la direzione non è significativa (l'errore di un GPS civile è dello stesso ordine) — nessuna direzione, mai un "N" ereditato da atan2(0, 0). */
export const MIN_DIRECTION_DISTANCE_M = 10;

const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
// Per etichette lette da uno screen reader / tooltip: "O" da solo è ambiguo (ovest o zero?).
const COMPASS_NAMES = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ovest", "ovest", "nord-ovest"];

/** Sotto questa distanza due punti sono lo stesso punto (es. longitudine -180 e 180): nessuna rotta da calcolare. */
const COINCIDENT_DISTANCE_M = 0.001;
/**
 * Una direzione in settori da 45° è credibile solo se l'errore di posizione non la sposta oltre mezzo
 * settore (±22.5°): errore angolare ≈ asin(accuratezza / distanza) ≤ 22.5° ⇒ accuratezza ≤ ~0.38 × distanza.
 * Oltre, il punto cardinale mostrato sarebbe spesso quello sbagliato — peggio di nessuna direzione. Conta solo
 * la accuratezza *propria* (la Geolocation API la dà); quella della posizione dichiarata dal bersaglio non
 * viaggia con il messaggio, quindi non è considerata: un limite onesto, non una garanzia.
 */
const MAX_ACCURACY_TO_DISTANCE_RATIO = 0.38;

/** A meno di tanto da un polo la rotta iniziale dipende solo dal rumore numerico — per convenzione si va verso sud dal polo nord, verso nord dal polo sud. */
const POLE_EPSILON_DEG = 1e-9;

function isValidPoint(p) {
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.lat === "number" &&
    typeof p.lon === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180
  );
}

const toRad = (deg) => (deg * Math.PI) / 180;

/** Distanza di cerchio massimo in metri (formula haversine, matematica di dominio pubblico). `undefined` se un punto non è valido. */
export function haversineDistanceMeters(from, to) {
  if (!isValidPoint(from) || !isValidPoint(to)) return undefined;
  const dLat = toRad(to.lat - from.lat);
  const dLon = toRad(to.lon - from.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Rotta iniziale da `from` verso `to`, in gradi [0, 360) dal nord in senso orario. `undefined` se un punto non è valido o i due punti coincidono (anche quando le coordinate differiscono, come longitudine -180 e 180). Partendo da un polo: 180 dal polo nord, 0 dal polo sud. */
export function bearingDegrees(from, to) {
  if (!isValidPoint(from) || !isValidPoint(to)) return undefined;
  if (haversineDistanceMeters(from, to) < COINCIDENT_DISTANCE_M) return undefined;
  if (Math.abs(from.lat) >= 90 - POLE_EPSILON_DEG) return from.lat > 0 ? 180 : 0;
  const dLon = toRad(to.lon - from.lon);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Punto cardinale a 8 settori (N, NE, E, SE, S, SO, O, NO — italiano, "O" = ovest) per una direzione in gradi. */
export function compassPoint(degrees) {
  if (typeof degrees !== "number" || !Number.isFinite(degrees)) return undefined;
  const normalized = ((degrees % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 45) % 8];
}

/** Nome esteso del punto cardinale ("nord-est") per tooltip e screen reader. */
export function compassName(degrees) {
  const point = compassPoint(degrees);
  return point === undefined ? undefined : COMPASS_NAMES[COMPASS_POINTS.indexOf(point)];
}

/**
 * Unica fonte del formato distanza: metri interi sotto il chilometro, chilometri con una cifra sopra. Lo
 * switch ai km si decide sul valore già arrotondato (999.6 m → "1.0 km", mai "1000 m").
 */
function distanceParts(meters) {
  if (typeof meters !== "number" || !Number.isFinite(meters) || meters < 0) return undefined;
  const rounded = Math.round(meters);
  if (rounded < 1000) return { short: rounded + " m", long: rounded + (rounded === 1 ? " metro" : " metri") };
  const km = (meters / 1000).toFixed(1);
  return { short: km + " km", long: km + " chilometri" };
}

/** "850 m" sotto il chilometro, "1.2 km" sopra (una cifra decimale) — stesso formato che app.js mostrava già prima di questo modulo. */
export function formatDistance(meters) {
  return distanceParts(meters)?.short;
}

/**
 * Tutto ciò che una UI vuole sapere su un bersaglio rispetto a me: distanza, direzione, punto cardinale,
 * un'unica etichetta pronta ("850 m NE", oppure solo "4 m") e una descrizione estesa per tooltip/screen
 * reader ("850 metri, direzione geografica verso nord-est"). `undefined` se uno dei due punti non è valido.
 *
 * La direzione è omessa — resta solo la distanza — quando non è affidabile: sotto MIN_DIRECTION_DISTANCE_M
 * (l'errore di un GPS civile è dello stesso ordine), quando `from.accuracy` (metri, come lo restituisce
 * la Geolocation API) supera MAX_ACCURACY_TO_DISTANCE_RATIO × distanza (l'errore angolare supererebbe
 * mezzo settore: una direzione sicura ma sbagliata è peggio di nessuna direzione), oppure se il chiamante passa `{ withDirection: false }`
 * (es. la mia posizione è vecchia: ci si è mossi da allora).
 */
export function describeTarget(from, to, options = {}) {
  const distanceM = haversineDistanceMeters(from, to);
  if (distanceM === undefined) return undefined;
  // Un'accuratezza negativa/NaN/assente è "sconosciuta", mai trattata come un fix perfetto né come un fix pessimo.
  const knownAccuracy = typeof from.accuracy === "number" && Number.isFinite(from.accuracy) && from.accuracy >= 0;
  const accuracyOk = !knownAccuracy || from.accuracy <= distanceM * MAX_ACCURACY_TO_DISTANCE_RATIO;
  const directionAllowed = options.withDirection !== false && distanceM >= MIN_DIRECTION_DISTANCE_M && accuracyOk;
  const bearing = directionAllowed ? bearingDegrees(from, to) : undefined;
  const compass = bearing === undefined ? undefined : compassPoint(bearing);
  const { short: distanceText, long: metersText } = distanceParts(distanceM);
  return {
    distanceM,
    bearingDegrees: bearing,
    compass,
    label: compass ? distanceText + " " + compass : distanceText,
    description: compass ? metersText + ", direzione geografica verso " + compassName(bearing) : metersText,
  };
}

const AraldGeoCore = { haversineDistanceMeters, bearingDegrees, compassPoint, compassName, formatDistance, describeTarget };

// The one deliberate bridge to the classic, non-module scripts in this directory — see ble-link.js's file header for the same pattern.
if (typeof window !== "undefined") {
  window.AraldGeoCore = AraldGeoCore;
}
