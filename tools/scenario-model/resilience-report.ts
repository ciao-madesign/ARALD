/**
 * Testo (Markdown) dei risultati di resilienza. Solo presentazione: tutti i valori vengono da
 * `resilience.ts`; il futuro tool disegnerà la stessa informazione sulla mappa.
 */
import type { Dependency, FailureReport, ResilienceScore, SingleFailureEntry } from "./resilience.js";

const pct = (x: number): string => `${(100 * x).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
const list = (ids: string[]): string => (ids.length === 0 ? "—" : ids.join(", "));

export function fmtArrival(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${(s / 60).toFixed(0)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

const COMPONENT_LABEL: Record<string, string> = {
  coverage: "Copertura connessa (rete integra)",
  directConnectivity: "Connettività diretta",
  reachability: "Raggiungibilità dell'infrastruttura (diretta o opportunistica)",
  redundancy: "Percorsi ridondanti",
  coverageUnderFailure: "Copertura connessa media dopo un guasto singolo",
  opportunisticRecovery: "Recupero opportunistico dei nodi tagliati fuori",
};

export function formatDependencies(deps: Dependency[], max = 8): string[] {
  if (deps.length === 0) return ["Nessuna dipendenza critica: nessun nodo, spegnendosi, taglia fuori un altro nodo."];
  const rows = ["| Nodo | Tipo | Nodi che perde | Smartphone che perde | Copertura persa |", "|---|---|---|---|---:|"];
  for (const d of deps.slice(0, max)) rows.push(`| ${d.id} | ${d.kind} | ${list(d.dependents)} | ${list(d.phoneDependents)} | ${pct(d.coverageLoss)} |`);
  if (deps.length > max) rows.push(`| … | | | | (altri ${deps.length - max}) |`);
  return rows;
}

export function formatFailureReport(r: FailureReport, title = "Guasto"): string[] {
  const out: string[] = [r.failed.length === 0 ? `**${title}**` : `**${title}: ${list(r.failed)}**`, ""];
  out.push("| Metrica | Prima | Dopo |", "|---|---:|---:|");
  out.push(`| Nodi attivi | ${r.nodes.activeBefore} | ${r.nodes.activeAfter} |`);
  out.push(`| Connessioni | ${r.connections.before} | ${r.connections.after} |`);
  out.push(`| Frammenti di rete | ${r.fragments.before} | ${r.fragments.after} |`);
  if (r.coverage) {
    out.push(`| Copertura connessa | ${pct(r.coverage.connectedBefore)} | ${pct(r.coverage.connectedAfter)} |`);
    out.push(`| Copertura radio | ${pct(r.coverage.radioBefore)} | ${pct(r.coverage.radioAfter)} |`);
  }
  out.push(`| Nodi isolati (nessun link) | — | ${r.isolated.length} |`, "");
  out.push(`- **Tagliati fuori dall'infrastruttura** (connessi prima, non più dopo): ${list(r.cutOff)}`);
  if (r.isolated.length > 0) out.push(`- **Isolati** (nessun link): ${list(r.isolated)}`);
  if (r.opportunistic) {
    const rec = r.recoverable;
    out.push(`- **Recuperabili con un percorso opportunistico**: ${rec.length === 0 ? "—" : rec.map((x) => `${x.id} (dopo ${fmtArrival(x.arrivalS)}${x.newlyCutOff ? "" : ", già non connesso prima"})`).join(", ")}`);
    const lost = r.cutOff.filter((id) => !rec.some((x) => x.id === id));
    out.push(`- **Senza alcun percorso, nemmeno opportunistico**: ${list(lost)}`);
  } else {
    out.push("- Percorsi opportunistici: non analizzati (nessuna finestra temporale)");
  }
  if (r.rerouted.length > 0) out.push(`- **Percorsi allungati o accorciati** verso l'infrastruttura: ${r.rerouted.map((x) => `${x.id} (${x.hopsBefore}→${x.hopsAfter} salti)`).join(", ")}`);
  if (r.coverage) out.push(`- **Aree rimaste scoperte**: ${r.lostCells.length} celle di copertura connessa perse`);
  const states = Object.entries(r.states).map(([id, s]) => `${id}:${s}`).join(" ");
  out.push(`- Stato dei nodi: ${states}`, "");
  out.push("**Dipendenze critiche nella rete residua**", "", ...formatDependencies(r.dependencies));
  return out;
}

export function formatSingleFailures(rows: SingleFailureEntry[]): string[] {
  const out = ["| Guasto singolo | Tipo | Nodi tagliati fuori | Smartphone tagliati fuori | Recuperabili (opportunistico) | Copertura connessa persa | Critico |", "|---|---|---|---|---|---:|:---:|"];
  for (const f of rows) out.push(`| ${f.id} | ${f.kind} | ${list(f.cutOff)} | ${list(f.phoneCutOff)} | ${list(f.recoverable)} | ${pct(f.coverageLoss)} | ${f.critical ? "sì" : "no"} |`);
  return out;
}

export function formatScore(s: ResilienceScore): string[] {
  const out = [`**Resilience Score: ${s.score.toFixed(0)} / 100**`, ""];
  out.push("| Componente | Valore | Peso |", "|---|---:|---:|");
  for (const c of s.components) out.push(`| ${COMPONENT_LABEL[c.key] ?? c.key} | ${c.value === null ? "non calcolabile (esclusa)" : pct(c.value)} | ${c.weight} |`);
  out.push("");
  out.push(`- **Nodi critici** (single point of failure): ${s.criticalNodes.length} — ${list(s.criticalNodes)}`);
  out.push(`- **Gap recuperabili** (tagliati fuori da un guasto singolo ma raggiungibili in modo opportunistico): ${s.recoverableGaps.length} — ${list(s.recoverableGaps)}`);
  out.push(`- **Peggior guasto singolo**: ${s.worstSingleFailure ? `${s.worstSingleFailure.id}, taglia fuori ${s.worstSingleFailure.cutOff} nodi` : "nessuno taglia fuori altri nodi"}`);
  return out;
}
