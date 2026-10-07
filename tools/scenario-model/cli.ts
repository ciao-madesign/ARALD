/**
 * Esegue il modello parametrico su uno scenario e stampa i risultati in
 * Markdown (riprodotti in docs/scenario-simulation.md).
 *
 *   npm run scenario-model                                  # Scenario 1, Valle Maira
 *   npm run scenario-model -- --scenario alpino-frammentato # Scenario 2
 *   npm run scenario-model -- --scenario eolie              # Scenario 3
 *   npm run scenario-model -- --max-sf 10 --horizon-h 24
 *   npm run scenario-model -- --config tools/scenario-model/examples/eolie.json [--json]
 *                                  # valuta una configurazione salvata (formato del futuro tool)
 *   npm run scenario-model -- --config <file.json> --resilience [--fail ID,ID] [--fail-area lat,lon,m]
 *        [--block-area lat,lon,m,dB] [--window oraDa,oraA[,passoS]] [--json]
 *                                  # test di resilienza: punteggio e dipendenze critiche, oppure l'effetto di un guasto
 *   npm run scenario-model -- --scenario eolie --variant hydrofoil --resilience [--fail ID]
 */
import { readFileSync } from "node:fs";
import {
  BUDGET_SHORT_RANGE, DEFAULT_PHY, DEFAULT_SHORT_RANGE, EU868_G1, EU868_G3, SPREADING_FACTORS, type ModelParams, type RegulatoryProfile,
  type SpreadingFactor, ARALD_QUEUE_TTL_S, loraFrameBytesFor, destinationsOf, nodePosition, loraDutyLimitedAppBps, loraRawAppBps, loraTimeOnAir, loraLink, simulate,
} from "./model.js";
import type { Scenario } from "./scenario.js";
import { valleMaira } from "./valle-maira.js";
import { alpinoFrammentato } from "./alpino-frammentato.js";
import { eolie } from "./eolie.js";
import { atacama } from "./atacama.js";
import { kampala } from "./kampala.js";
import { TERRAINS } from "./terrains.js";
import { type LinkAssessment, assessLink, coverageGrid, qualityLabel } from "./assess.js";
import { assessNetwork, paramsForConfig, parseNetworkConfig, placeDevices } from "./network-config.js";
import { type FailureArea, type FailureSpec, criticalDependencies, evaluateFailure, prepareResilience, resilienceScore } from "./resilience.js";
import { formatDependencies, formatFailureReport, formatScore, formatSingleFailures } from "./resilience-report.js";
import type { LocalFrame } from "./terrain.js";
import type { NodeSpec } from "./model.js";
import { FLAT_TERRAIN, type Terrain } from "./terrain.js";

const SCENARIOS: Record<string, Scenario> = { [valleMaira.id]: valleMaira, [alpinoFrammentato.id]: alpinoFrammentato, [eolie.id]: eolie, [atacama.id]: atacama, [kampala.id]: kampala };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function cliError(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function profileIndex(n: number, fallback: number): number {
  const raw = arg("profile", "");
  if (!raw) return fallback % n;
  const i = Number(raw);
  if (!Number.isInteger(i) || i < 0 || i >= n) cliError(`--profile non valido: atteso un intero tra 0 e ${n - 1} (ricevuto "${raw}")`);
  return i;
}

function argAll(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((v, i) => { if (v === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

/** "a,b,m[,dB]" → area circolare. Con `frame` a,b sono lat,lon; senza, x,y locali in metri. */
function parseArea(spec: string, frame: LocalFrame | undefined, failNodes: boolean, withLoss: boolean): FailureArea {
  const v = spec.split(",").map(Number);
  if (v.length < (withLoss ? 4 : 3) || v.some((x) => !Number.isFinite(x))) throw new Error(`Area non valida: "${spec}" (attesi ${withLoss ? "a,b,raggioM,perditaDb" : "a,b,raggioM"})`);
  if (!(v[2] > 0)) throw new Error(`Area non valida: "${spec}" (il raggio deve essere positivo)`);
  if (withLoss && !(v[3] > 0)) throw new Error(`Area non valida: "${spec}" (la perdita in dB deve essere positiva)`);
  if (!frame) console.error(`Nota: senza coordinate geografiche "${spec}" è letta come x,y locali in metri`);
  return {
    shape: { kind: "circle", center: frame ? { lat: v[0], lon: v[1] } : { x: v[0], y: v[1] }, radiusM: v[2] },
    failNodes,
    blockLossDb: withLoss ? v[3] : 0,
  };
}

/** Test di resilienza per un insieme di nodi e un modello: punteggio, oppure effetto di un guasto. */
function runResilience(title: string, nodes: NodeSpec[], p: ModelParams, frame: LocalFrame | undefined, atS: number, defaultWindow: { fromS: number; toS: number; stepS: number } | undefined, extraLossDb?: (tS: number) => number): void {
  const w = arg("window", "").split(",").filter(Boolean).map(Number);
  if (arg("window", "") && (w.length < 2 || w.length > 3 || w.some((x) => !Number.isFinite(x)) || w[1] < w[0] || (w[2] !== undefined && !(w[2] > 0)))) cliError(`--window non valida: attesi oraDa,oraA[,passoS] con oraA ≥ oraDa (ricevuto "${arg("window", "")}")`);
  const window = w.length >= 2 ? { fromS: w[0] * 3600, toS: w[1] * 3600, stepS: w[2] ?? 60 } : defaultWindow;
  const atArg = arg("at", "");
  if (atArg && !Number.isFinite(Number(atArg))) cliError(`--at non valido: attesa un'ora in ore (ricevuto "${atArg}")`);
  const ctx = (() => {
    try { return prepareResilience({ params: p, nodes, atS: atArg ? Number(atArg) * 3600 : atS, window, frame, skipCoverage: !p.env.terrain, extraLossDb }); } catch (e) { return cliError((e as Error).message); }
  })();
  const failNodes = arg("fail", "").split(",").filter(Boolean);
  const unknown = failNodes.filter((id) => !nodes.some((n) => n.id === id));
  if (unknown.length > 0) cliError(`Nodo sconosciuto in --fail: ${unknown.join(", ")}. Nodi disponibili: ${nodes.map((n) => n.id).join(", ")}`);
  let areas: FailureArea[];
  try {
    areas = [...argAll("fail-area").map((s) => parseArea(s, frame, true, false)), ...argAll("block-area").map((s) => parseArea(s, frame, false, true))];
  } catch (e) { return cliError((e as Error).message); }
  const spec: FailureSpec = { nodes: failNodes, areas };
  const failing = failNodes.length > 0 || areas.length > 0;
  const tl = ctx.spec.timeline;
  const windowText = tl && tl.steps.length > 1 ? `finestra opportunistica ${(Math.max(tl.fromS, ctx.spec.atS ?? tl.fromS) / 3600).toFixed(2)}–${(tl.steps[tl.steps.length - 1].t / 3600).toFixed(2)} h` : "nessun nodo mobile: solo connettività diretta";
  if (failing) {
    const report = evaluateFailure(ctx, spec);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ title, spec, report }, null, 2));
    else console.log([`### ${title.replace(/\s*\(test di resilienza\)$/, "")} — test di resilienza (${windowText})\n`, ...formatFailureReport(report, report.failed.length === 0 ? "Nessun nodo spento, percorsi ostruiti" : report.failed.length > 1 ? "Guasti multipli" : "Guasto singolo")].join("\n"));
    return;
  }
  const score = resilienceScore(ctx);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ title, score }, null, 2));
    return;
  }
  console.log([
    `### ${title} — Network Resilience (${windowText})\n`, ...formatScore(score), "",
    "**Guasti singoli, dal più dannoso**", "", ...formatSingleFailures(score.singleFailures), "",
    "**Dipendenze critiche della rete integra**", "", ...formatDependencies(criticalDependencies(ctx)),
  ].join("\n"));
}

function fmtRate(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(bps >= 1e4 ? 0 : 1)} kbps`;
  return `${bps.toFixed(0)} bps`;
}

/** Pannello connessioni (docs/network-design-tool.md §7) da un elenco di valutazioni. */
function connectionPanel(links: LinkAssessment[]): string[] {
  const rows = ["| Connessione | Tecnologia | Distanza | Velocità stimata | Sostenuta | Qualità | Linea di vista |", "|---|---|---:|---:|---:|---|:---:|"];
  for (const l of links) {
    const b = l.best!;
    rows.push(`| ${l.a} → ${l.b} | ${b.technology === "wifi" ? "Wi-Fi" : b.technology === "ble" ? "BLE" : "LoRa"} (${b.mode}) | ${l.distanceM >= 1000 ? `${(l.distanceM / 1000).toFixed(1)} km` : `${Math.round(l.distanceM)} m`} | ${fmtRate(b.rateBps)} | ${fmtRate(b.sustainedBps)} | ${qualityLabel(b.quality)} (${b.quality.toFixed(2)}) | ${l.terrain === null ? "—" : l.terrain.lineOfSight ? "sì" : "no"} |`);
  }
  return rows;
}

const configPath = arg("config", "");
if (configPath) {
  const cfg = parseNetworkConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const terrain = cfg.terrain === undefined ? FLAT_TERRAIN : Object.hasOwn(TERRAINS, cfg.terrain) ? TERRAINS[cfg.terrain] : undefined;
  if (!terrain) {
    console.error(`Territorio sconosciuto: ${cfg.terrain}. Disponibili: ${Object.keys(TERRAINS).join(", ")}`);
    process.exit(1);
  }
  if (process.argv.includes("--resilience")) {
    const nodes = placeDevices(cfg, terrain);
    const times = cfg.devices.flatMap((d) => d.route?.map((q) => q.tS) ?? []);
    const win = times.length > 0 ? { fromS: Math.min(...times), toS: Math.max(...times), stepS: 60 } : undefined;
    runResilience(cfg.name, nodes, paramsForConfig(cfg, terrain), cfg.frame, win?.fromS ?? 0, win);
    process.exit(0);
  }
  const links = assessNetwork(cfg, terrain);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ config: cfg.name, links }, null, 2));
  else console.log([`### ${cfg.name} — connessioni (${cfg.environment}, ${cfg.regulatory}, territorio: ${terrain.name})\n`, ...connectionPanel(links)].join("\n"));
  process.exit(0);
}

const policy = arg("policy", "custody") as "custody" | "epidemic";
const maxSf = Number(arg("max-sf", "12")) as SpreadingFactor;
const horizonH = Number(arg("horizon-h", "10"));
const scenarioId = arg("scenario", valleMaira.id);
const scenario = SCENARIOS[scenarioId];
if (!scenario) {
  console.error(`Scenario sconosciuto: ${scenarioId}. Disponibili: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}

function fmtClock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

function params(envName: string, reg: RegulatoryProfile): ModelParams {
  return {
    env: scenario.environments[envName], reg, phy: DEFAULT_PHY,
    shortRange: scenario.shortRangeModel === "budget" ? BUDGET_SHORT_RANGE : DEFAULT_SHORT_RANGE,
    loraFrameBytes: 222, loraFrameOverheadBytes: 22, protocolOverhead: 1.45, channelEfficiency: 0.5, maxSf,
  };
}

export function fmtDuration(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} giorni`;
}

if (process.argv.includes("--resilience") && arg("variant", "") === "all") {
  // Confronto del Resilience Score tra tutte le varianti dello scenario.
  const profiles = scenario.regulatoryProfiles ?? [["g1", EU868_G1], ["g3", EU868_G3]];
  const [profileName, reg] = profiles[profileIndex(profiles.length, scenario.regulatoryProfiles ? 0 : 1)];
  const env = arg("env", "tipico");
  const ignored = ["fail", "fail-area", "block-area", "at"].filter((f) => process.argv.includes(`--${f}`));
  if (ignored.length > 0) console.error(`Nota: con --variant all ${ignored.map((f) => `--${f}`).join(", ")} sono ignorati (confronto tra varianti della rete integra)`);
  const rows = Object.keys(scenario.variants).map((variant) => {
    const ctx = prepareResilience({ params: params(env, reg), nodes: scenario.buildNodes(variant), atS: scenario.eventT, window: { fromS: 0, toS: horizonH * 3600, stepS: 60 }, skipCoverage: !params(env, reg).env.terrain, extraLossDb: scenario.extraLossDb?.(variant) });
    return { variant, ...resilienceScore(ctx) };
  });
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows.map(({ variant, score, components, criticalNodes, recoverableGaps, worstSingleFailure }) => ({ variant, score, components, criticalNodes, recoverableGaps, worstSingleFailure })), null, 2));
  else {
    const out2 = [`### ${scenario.title} — Resilience Score per variante (ambiente ${env}, ${profileName}, finestra 0–${horizonH} h)\n`, "| Variante | Score | Copertura | Diretta | Raggiungibile | Ridondanza | Copertura sotto guasto | Recupero opp. | Nodi critici | Gap recuperabili | Peggior guasto |", "|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|"];
    const v = (r: (typeof rows)[number], k: string) => { const x = r.components.find((c) => c.key === k)!.value; return x === null ? "—" : `${Math.round(100 * x)}%`; };
    for (const r of rows) out2.push(`| ${r.variant} | **${r.score.toFixed(0)}** | ${v(r, "coverage")} | ${v(r, "directConnectivity")} | ${v(r, "reachability")} | ${v(r, "redundancy")} | ${v(r, "coverageUnderFailure")} | ${v(r, "opportunisticRecovery")} | ${r.criticalNodes.join(", ") || "—"} | ${r.recoverableGaps.join(", ") || "—"} | ${r.worstSingleFailure ? `${r.worstSingleFailure.id} (${r.worstSingleFailure.cutOff})` : "—"} |`);
    console.log(out2.join("\n"));
  }
  process.exit(0);
}

if (process.argv.includes("--resilience")) {
  const variant = arg("variant", scenario.linkSnapshotVariant);
  if (!Object.hasOwn(scenario.variants, variant)) {
    console.error(`Variante sconosciuta: ${variant}. Disponibili: ${Object.keys(scenario.variants).join(", ")}`);
    process.exit(1);
  }
  const profiles = scenario.regulatoryProfiles ?? [["g1", EU868_G1], ["g3", EU868_G3]];
  const [profileName, reg] = profiles[profileIndex(profiles.length, scenario.regulatoryProfiles ? 0 : 1)];
  const env = arg("env", "tipico");
  if (!Object.hasOwn(scenario.environments, env)) {
    console.error(`Ambiente sconosciuto: ${env}. Disponibili: ${Object.keys(scenario.environments).join(", ")}`);
    process.exit(1);
  }
  runResilience(`${scenario.title} — variante ${variant}, ambiente ${env}, ${profileName}`, scenario.buildNodes(variant), params(env, reg), undefined, scenario.eventT, { fromS: 0, toS: horizonH * 3600, stepS: 60 }, scenario.extraLossDb?.(variant));
  process.exit(0);
}

const out: string[] = [];
const p0 = params("tipico", EU868_G1);
const SIZES: [string, number][] = [["SOS 1 KB", 1024], ["Wiki ~70 KB", 70 * 1024], ["GPS+audio 150 KB", 150 * 1024], ["Report 5 MB", 5 * 1024 ** 2], ["8 JPEG 12 MB", 12 * 1024 ** 2]];

out.push("### A. Capacità LoRa per spreading factor (singolo hop, BW 125 kHz, CR 4/5, frame 222 B, overhead ARALD ×1,45)\n");
out.push("| SF | ToA frame | Throughput a canale libero | Sostenuto 1% (g1) | Sostenuto 10% (g3) |");
out.push("|---|---:|---:|---:|---:|");
for (const sf of SPREADING_FACTORS) {
  const raw = loraRawAppBps(sf, p0);
  out.push(`| SF${sf} | ${(loraTimeOnAir(222, sf) * 1000).toFixed(0)} ms | ${(raw / 1000).toFixed(2)} kbps | ${(loraDutyLimitedAppBps(sf, params("tipico", EU868_G1))).toFixed(0)} bps | ${(loraDutyLimitedAppBps(sf, params("tipico", EU868_G3))).toFixed(0)} bps |`);
}
out.push("\n### B. Tempo di trasferimento su un singolo hop LoRa, con duty-cycle legale\n");
out.push(`| File | SF7 · 1% | SF7 · 10% | SF10 · 1% | SF10 · 10% | SF12 · 10% |`);
out.push("|---|---:|---:|---:|---:|---:|");
for (const [label, bytes] of SIZES) {
  const t = (sf: SpreadingFactor, reg: RegulatoryProfile) => {
    // il primo burst usa il bucket pieno (36 s o 360 s di airtime), poi la ricarica
    const pr = params("tipico", reg);
    const airNeeded = (bytes / (loraRawAppBps(sf, pr) / 8));
    const burst = reg.dutyCycle * 3600;
    return airNeeded <= burst ? airNeeded : burst + (airNeeded - burst) / reg.dutyCycle;
  };
  out.push(`| ${label} | ${fmtDuration(t(7, EU868_G1))} | ${fmtDuration(t(7, EU868_G3))} | ${fmtDuration(t(10, EU868_G1))} | ${fmtDuration(t(10, EU868_G3))} | ${fmtDuration(t(12, EU868_G3))} |`);
}

if (scenario.regulatoryProfiles) {
  out.push(`\n### B2. Capacità LoRa per SF con i profili regolatori di questo scenario\n`);
  out.push("Con un dwell time massimo il frame si accorcia agli SF lenti; \"—\" = SF inutilizzabile (nemmeno un frame minimo sta nel dwell time).\n");
  out.push(`| SF | ${scenario.regulatoryProfiles.map(([n]) => `${n}: frame · istantanea · sostenuta`).join(" | ")} |`);
  out.push(`|---|${scenario.regulatoryProfiles.map(() => "---:").join("|")}|`);
  for (const sf of SPREADING_FACTORS) {
    const cells = scenario.regulatoryProfiles.map(([, reg]) => {
      const pr = params("tipico", reg);
      const frame = loraFrameBytesFor(sf, pr);
      return frame === 0 ? "—" : `${frame} B · ${fmtRate(loraRawAppBps(sf, pr))} · ${fmtRate(loraDutyLimitedAppBps(sf, pr))}`;
    });
    out.push(`| SF${sf} | ${cells.join(" | ")} |`);
  }
}

out.push(`\n### C. ${scenario.title} — link LoRa stimati a t = ${fmtClock(scenario.eventT)} (variante \`${scenario.linkSnapshotVariant}\`), SF minimo che chiude il link\n`);
const nodes = scenario.buildNodes(scenario.linkSnapshotVariant);
const pairs = scenario.linkPairs;
const regs: [string, RegulatoryProfile][] = scenario.regulatoryProfiles ?? [["g1 14 dBm ERP/1%", EU868_G1], ["g3 27 dBm ERP/10%", EU868_G3]];
const envNames = Object.keys(scenario.environments);
out.push(`| Link | Distanza | ${envNames.flatMap((e) => regs.map(([r]) => `${e} ${r}`)).join(" | ")} |`);
out.push(`|---|---:|${envNames.flatMap(() => regs.map(() => ":---:")).join("|")}|`);
for (const [a, b] of pairs) {
  const na = nodes.find((n) => n.id === a)!;
  const nb = nodes.find((n) => n.id === b)!;
  const pa = nodePosition(na, scenario.eventT, scenario.environments.tipico?.terrain);
  const pb = nodePosition(nb, scenario.eventT, scenario.environments.tipico?.terrain);
  const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  const cells = envNames.flatMap((e) => regs.map(([, reg]) => {
    const l = loraLink(na, pa, nb, pb, params(e, reg));
    return l ? `SF${l.sf}` : "✗";
  }));
  out.push(`| ${a}–${b} | ${(d / 1000).toFixed(1)} km | ${cells.join(" | ")} |`);
}

out.push(`\n### D. Tempi di consegna end-to-end (policy ${policy}, SF max ${maxSf}, orizzonte ${horizonH} h dalla partenza; file generati a ${fmtClock(scenario.eventT)})\n`);
const msgs = scenario.messages();
// Un messaggio con più destinazioni ha una colonna per destinazione.
const columns = msgs.flatMap((m) => {
  const dests = destinationsOf(m);
  return dests.length === 1 ? [{ m, dest: null as string | null, label: m.id }] : dests.map((d) => ({ m, dest: d as string | null, label: `${m.id}→${d}` }));
});
const [connSrc, connDst] = scenario.connectivityPair;
const H = 3600;
const carryModels: [string, ((prio: number) => number) | undefined][] = [
  ["ARALD attuale — coda relay: SOS senza scadenza / resto 5 min", ARALD_QUEUE_TTL_S],
  ["DTN — il relay trattiene la copia fino alla consegna", undefined],
];
function resultsTable(title: string, reg: RegulatoryProfile, carry: ((prio: number) => number) | undefined, routingMetric: "hops" | "airtime") {
  out.push(`\n**${title}**\n`);
  out.push(`| Variante | Ambiente | ${columns.map((col) => col.label).join(" | ")} | ${connSrc}→${connDst} connesso (istantaneo) | Airtime LoRa |`);
  out.push(`|---|---|${columns.map(() => "---:").join("|")}|---:|---:|`);
  for (const variant of Object.keys(scenario.variants)) {
    for (const e of envNames) {
      const r = simulate({
        nodes: scenario.buildNodes(variant), messages: msgs, params: params(e, reg), horizonS: horizonH * H, stepS: 10, policy,
        relayCarryTtlS: carry, extraLossDb: scenario.extraLossDb?.(variant), routingMetric,
      });
      const cells = columns.map(({ m, dest }) => {
        const d = r.deliveries.find((x) => x.messageId === m.id)!;
        if (dest !== null) return fmtDuration(d.deliveredAtByDest[dest]);
        if (d.deliveredAt !== null) return fmtDuration(d.deliveredAt);
        const pct = (100 * d.bytesAtDestination) / m.sizeBytes;
        return pct > 0 ? `✗ (${pct.toFixed(pct < 1 ? 1 : 0)}%)` : "✗";
      });
      const conn = r.instantConnectivity[`${connSrc}->${connDst}`];
      const air = r.deliveries.reduce((s, d) => s + d.loraAirtimeS, 0);
      out.push(`| ${variant} | ${e} | ${cells.join(" | ")} | ${conn === undefined ? "—" : `${(conn * 100).toFixed(0)}%`} | ${(air / 60).toFixed(1)} min |`);
    }
  }
}

for (const [carryName, carry] of carryModels) {
  for (const [regName, reg] of regs) resultsTable(`${carryName} · profilo radio ${regName}`, reg, carry, "hops");
}
if (policy === "custody") {
  out.push(`\n### E. Stessa simulazione con instradamento a costo "airtime" invece che a numero di salti (coda relay ARALD attuale)\n`);
  for (const [regName, reg] of regs) resultsTable(`Metrica airtime · ${carryModels[0][0]} · profilo radio ${regName}`, reg, carryModels[0][1], "airtime");
}
out.push(`\nLegenda D/E: ${msgs.map((m) => `${m.id} = ${m.label} (${m.source}→${destinationsOf(m).join(" e ")})`).join("; ")}. "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato; "—" = destinazione non raggiunta. "${connSrc}→${connDst} connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: ${Object.entries(scenario.variants).map(([k, v]) => `${k} = ${v}`).join("; ")}.`);

const terrain = scenario.environments.tipico?.terrain;
if (terrain) {
  out.push(`\n### F. Pannello connessioni a t = ${fmtClock(scenario.eventT)} (variante \`${scenario.linkSnapshotVariant}\`, ambiente tipico) — formato del futuro tool\n`);
  const snapNodes = scenario.buildNodes(scenario.linkSnapshotVariant);
  for (const [regName, reg] of regs) {
    const pr = params("tipico", reg);
    const links: LinkAssessment[] = [];
    for (let i = 0; i < snapNodes.length; i++) {
      for (let j = i + 1; j < snapNodes.length; j++) {
        const l = assessLink(snapNodes[i], nodePosition(snapNodes[i], scenario.eventT, terrain), snapNodes[j], nodePosition(snapNodes[j], scenario.eventT, terrain), pr);
        if (l.best) links.push(l);
      }
    }
    links.sort((x, y) => y.best!.quality - x.best!.quality);
    out.push(`\n**Profilo radio ${regName}**\n`);
    out.push(...connectionPanel(links));
  }

  const xsAll = snapNodes.flatMap((n) => n.path.map((w) => w.x));
  const ysAll = snapNodes.flatMap((n) => n.path.map((w) => w.y));
  // Celle da 1 km, più grandi solo se l'area supera ~60 km (mappa leggibile).
  const span = Math.max(Math.max(...xsAll) - Math.min(...xsAll), Math.max(...ysAll) - Math.min(...ysAll)) + 8000;
  const gCell = scenario.coverageCellM ?? Math.max(1000, Math.ceil(span / 60 / 500) * 500);
  out.push(`\n### G. Alone di copertura LoRa del Box (ricevitore di riferimento: Card), ambiente tipico, celle da ${gCell >= 1000 ? `${gCell / 1000} km` : `${gCell} m`}\n`);
  const box = snapNodes.find((n) => n.kind === "box")!;
  const boxPos = nodePosition(box, scenario.eventT, terrain);
  const xs = snapNodes.flatMap((n) => n.path.map((w) => w.x));
  const ys = snapNodes.flatMap((n) => n.path.map((w) => w.y));
  const margin = (scenario.coverageCellM ?? 0) * 6 || 4000; // 6 celle di margine attorno ai nodi (4 km se la dimensione è automatica)
  const bbox = { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin };
  const gridsG = regs.map(([regName, reg]) => ({ regName, g: coverageGrid(box, boxPos, "lora", params("tipico", reg), bbox, gCell) }));
  const hasSea = gridsG[0].g.cells.some((cell) => terrain.landCoverAt(cell.x, cell.y) === "sea");
  out.push(`Legenda: \`#\` terra coperta, ${hasSea ? "`+` mare coperto, " : ""}\`.\` terra non coperta, ${hasSea ? "spazio = mare non coperto, " : ""}\`B\` posizione del Box.\n`);
  for (const { regName, g } of gridsG) {
    const covered = g.cells.filter((c) => c.possible).length;
    out.push(`\n**${regName}** — celle coperte: ${covered} su ${g.cells.length}\n`);
    out.push("```text");
    for (let r = 0; r < g.rows; r++) {
      let line = "";
      for (let c = 0; c < g.cols; c++) {
        const cell = g.cells[r * g.cols + c];
        const isBox = Math.abs(cell.x - boxPos.x) <= gCell / 2 && Math.abs(cell.y - boxPos.y) <= gCell / 2;
        const land = terrain.landCoverAt(cell.x, cell.y) !== "sea";
        line += isBox ? "B" : cell.possible ? (land ? "#" : "+") : land ? "." : " ";
      }
      out.push(line.replace(/\s+$/, ""));
    }
    out.push("```");
  }

  out.push(`\n### H. I tre livelli dell'alone del Box, uno per tecnologia (celle da 40 m, ±1 km, ambiente tipico, ${regs[0][0]})\n`);
  out.push("Ogni livello è calcolato separatamente verso il proprio ricevitore di riferimento (Wi-Fi e BLE → smartphone, LoRa → Card). `#` = coperto, `.` = non coperto, `B` = Box. Con celle da 40 m, una copertura di poche celle attorno al Box indica una portata di qualche decina di metri o meno: la risoluzione non permette di dire di più. La forma dell'alone che segue il territorio si vede su LoRa, sezione G.\n");
  const zoom = { minX: boxPos.x - 1000, maxX: boxPos.x + 1000, minY: boxPos.y - 1000, maxY: boxPos.y + 1000 };
  const pz = params("tipico", regs[0][1]);
  const layers = (["wifi", "ble", "lora"] as const).map((tech) => coverageGrid(box, boxPos, tech, pz, zoom, 40));
  const names = ["Wi-Fi", "BLE", "LoRa"];
  out.push("```text");
  out.push(names.map((nm) => nm.padEnd(layers[0].cols, " ")).join("   ").trimEnd());
  for (let r = 0; r < layers[0].rows; r++) {
    out.push(layers.map((g) => {
      let line = "";
      for (let c = 0; c < g.cols; c++) {
        const cell = g.cells[r * g.cols + c];
        line += Math.abs(cell.x - boxPos.x) <= 20 && Math.abs(cell.y - boxPos.y) <= 20 ? "B" : cell.possible ? "#" : ".";
      }
      return line;
    }).join("   "));
  }
  out.push("```");
  out.push(...layers.map((g, i) => {
    const n = g.cells.filter((x) => x.possible).length;
    return `- ${names[i]}: ${n} celle coperte su ${g.cells.length} (${Math.round(n * 40 * 40)} m²)`;
  }));
}

console.log(out.join("\n"));
