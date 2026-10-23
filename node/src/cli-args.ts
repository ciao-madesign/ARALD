/**
 * Controllo (non bloccante) degli argomenti di `cli.ts`: `parseArgs()` accetta qualunque token, quindi un flag scritto
 * male (`-- identity-dir`, `--identiti-dir`) non dava alcun segnale e il nodo partiva senza quell'impostazione
 * (docs/security.md voce #146: Box senza identità persistente). Solo avvisi su stderr, mai un errore: un deployment
 * esistente con un flag in più non deve smettere di avviarsi.
 */

/** Tutti i flag che `cli.ts` legge. Un test confronta questo elenco con il sorgente di `cli.ts` per non lasciarlo invecchiare. */
export const KNOWN_FLAGS: readonly string[] = [
  "allow-remote-content-ingest", "allow-remote-external-delivery-ingest", "allow-remote-node-append-ingest",
  "allow-remote-reboot", "allow-remote-relay-command-ingest", "allow-service-calls", "auth-max-failures",
  "auth-throttle-include-local", "auth-window-ms", "battery-percent", "config", "connect", "data-dir", "device-class",
  "discover-peer", "discovery-public-address", "discovery-public-label", "discovery-register-interval-ms",
  "discovery-service-url", "expose-emergency-beacons", "expose-location-registry", "expose-relay-registry",
  "external-delivery-destinations", "external-delivery-poll-interval-ms", "external-delivery-ttl-ms", "id",
  "identity-dir", "lora-bandwidth-hz", "lora-baud-rate", "lora-chip", "lora-coding-rate-denominator",
  "lora-frequency-hz", "lora-serial-port", "lora-spreading-factor", "lora-tx-power-dbm", "map-file",
  "max-external-delivery-bytes", "max-external-delivery-entries", "max-external-delivery-payload-bytes",
  "network-name", "network-password", "network-password-file", "no-auth-throttle", "open-browser", "pairing-on-lan", "port", "portable",
  "public-host", "register-as-location-registry", "register-as-relay-registry",
  "report-relay-telemetry-interval-ms", "trust-admin", "web-host", "web-port",
];

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Il flag noto più vicino a `flag` (distanza di modifica piccola, proporzionale alla lunghezza), per il «forse intendevi». */
function closestKnownFlag(flag: string, known: readonly string[]): string | undefined {
  if (flag.length < 4 || ["help", "version"].includes(flag)) return undefined; // nomi corti o d'uso comune: suggerimenti quasi sempre spuri
  let best: string | undefined;
  let bestDistance = Math.min(4, Math.max(2, Math.floor(flag.length / 4) + 1));
  for (const k of known) {
    const d = editDistance(flag, k);
    if (d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best;
}

/** Mostra un nome di flag solo se ha la forma di un nome di flag: un token che ne ha un'altra potrebbe essere un valore segreto (una password) finito al posto sbagliato, e gli avvisi finiscono nel journal. */
function safeFlagName(name: string): string | undefined {
  return /^[a-z][a-z0-9-]{0,40}$/.test(name) ? name : undefined;
}

/** Messaggi di avviso per gli argomenti che `parseArgs()` ignorerebbe o prenderebbe per un flag inesistente. Vuoto se tutto è a posto. */
export function findArgProblems(argv: string[], known: readonly string[] = KNOWN_FLAGS): string[] {
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      // il valore NON viene mostrato: potrebbe essere una password rimasta senza il suo flag
      problems.push("argomento ignorato (valore non mostrato): un valore va subito dopo il suo flag, e ogni flag inizia con --");
      continue;
    }
    const flag = token.slice(2);
    if (flag === "") {
      const next = argv[i + 1];
      const name = next !== undefined && !next.startsWith("--") ? safeFlagName(next) : undefined;
      problems.push(next !== undefined && !next.startsWith("--")
        ? (name ? `"-- ${name}" non è un flag valido (spazio di troppo?): forse intendevi --${name}` : `"--" seguito da un argomento non è un flag valido (spazio di troppo?); l'argomento è ignorato (non mostrato)`)
        : `"--" da solo non è un flag e viene ignorato`);
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    if (!known.includes(flag)) {
      const guess = closestKnownFlag(flag, known);
      const shown = safeFlagName(flag);
      problems.push(shown ? `flag sconosciuto: --${shown}${guess ? ` (forse intendevi --${guess}?)` : ""}; viene ignorato` : "flag sconosciuto (nome non mostrato); viene ignorato");
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) i++;
  }
  return problems;
}
