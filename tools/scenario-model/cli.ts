/**
 * Esegue il modello parametrico sullo scenario Valle Maira e stampa i
 * risultati in Markdown (riprodotti in docs/scenario-simulation.md).
 *
 *   npm run scenario-model
 *   npm run scenario-model -- --max-sf 10 --horizon-h 24
 */
import {
  DEFAULT_PHY, DEFAULT_SHORT_RANGE, EU868_G1, EU868_G3, SPREADING_FACTORS, type ModelParams, type RegulatoryProfile,
  type SpreadingFactor, loraDutyLimitedAppBps, loraRawAppBps, loraTimeOnAir, positionAt, loraLink, simulate,
} from "./model.js";
import { ENVIRONMENTS, EVENT_T, VARIANTS, type Variant, benchmarkMessages, buildNodes } from "./valle-maira.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const policy = arg("policy", "custody") as "custody" | "epidemic";
const maxSf = Number(arg("max-sf", "12")) as SpreadingFactor;
const horizonH = Number(arg("horizon-h", "10"));

function params(envName: keyof typeof ENVIRONMENTS, reg: RegulatoryProfile): ModelParams {
  return {
    env: ENVIRONMENTS[envName], reg, phy: DEFAULT_PHY, shortRange: DEFAULT_SHORT_RANGE,
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

out.push(`\n### C. Link LoRa stimati a t = 3h15 (gruppo distribuito), SF minimo che chiude il link\n`);
const nodes = buildNodes("static");
const pairs: [string, string][] = [["BOX", "C2"], ["BOX", "C3"], ["BOX", "C4"], ["BOX", "C5"], ["C2", "C3"], ["C3", "C4"], ["C4", "C5"], ["C3", "C5"], ["PORT", "C3"], ["PORT", "C4"], ["PORT", "C5"]];
const regs: [string, RegulatoryProfile][] = [["g1 14 dBm ERP/1%", EU868_G1], ["g3 27 dBm ERP/10%", EU868_G3]];
const envNames = Object.keys(ENVIRONMENTS) as (keyof typeof ENVIRONMENTS)[];
out.push(`| Link | Distanza | ${envNames.flatMap((e) => regs.map(([r]) => `${e} ${r}`)).join(" | ")} |`);
out.push(`|---|---:|${envNames.flatMap(() => regs.map(() => ":---:")).join("|")}|`);
for (const [a, b] of pairs) {
  const na = nodes.find((n) => n.id === a)!;
  const nb = nodes.find((n) => n.id === b)!;
  const pa = positionAt(na.path, EVENT_T);
  const pb = positionAt(nb.path, EVENT_T);
  const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  const cells = envNames.flatMap((e) => regs.map(([, reg]) => {
    const l = loraLink(na, pa, nb, pb, params(e, reg));
    return l ? `SF${l.sf}` : "✗";
  }));
  out.push(`| ${a}–${b} | ${(d / 1000).toFixed(1)} km | ${cells.join(" | ")} |`);
}

out.push(`\n### D. Tempi di consegna end-to-end (policy ${policy}, SF max ${maxSf}, orizzonte ${horizonH} h dalla partenza; file generati a 3h15)\n`);
const msgs = benchmarkMessages();
const H = 3600;
const carryModels: [string, ((prio: number) => number) | undefined][] = [
  ["ARALD attuale — coda relay 30 min SOS / 5 min resto", (prio) => (prio === 0 ? 0.5 * H : 300)],
  ["DTN — il relay trattiene la copia fino alla consegna", undefined],
];
for (const [carryName, carry] of carryModels) {
  for (const [regName, reg] of regs) {
    out.push(`\n**${carryName} · profilo radio ${regName}**\n`);
    out.push(`| Variante | Ambiente | ${msgs.map((m) => m.id).join(" | ")} | C5→BOX connesso (istantaneo) | Airtime LoRa |`);
    out.push(`|---|---|${msgs.map(() => "---:").join("|")}|---:|---:|`);
    for (const variant of Object.keys(VARIANTS) as Variant[]) {
      for (const e of envNames) {
        const r = simulate({ nodes: buildNodes(variant), messages: msgs, params: params(e, reg), horizonS: horizonH * H, stepS: 10, policy, relayCarryTtlS: carry });
        const cells = r.deliveries.map((d) => {
          if (d.deliveredAt !== null) return fmtDuration(d.deliveredAt);
          const m = msgs.find((x) => x.id === d.messageId)!;
          const pct = (100 * d.bytesAtDestination) / m.sizeBytes;
          return pct > 0 ? `✗ (${pct.toFixed(pct < 1 ? 1 : 0)}%)` : "✗";
        });
        const conn = r.instantConnectivity["C5->BOX"];
        const air = r.deliveries.reduce((s, d) => s + d.loraAirtimeS, 0);
        out.push(`| ${variant} | ${e} | ${cells.join(" | ")} | ${conn === undefined ? "—" : `${(conn * 100).toFixed(0)}%`} | ${(air / 60).toFixed(1)} min |`);
      }
    }
  }
}
out.push(`\nLegenda D: ${msgs.map((m) => `${m.id} = ${m.label} (${m.source}→${m.destination})`).join("; ")}. "✗ (x%)" = non consegnato entro l'orizzonte, x% arrivato. "C5→BOX connesso" = frazione del tempo con un percorso simultaneo (connettività istantanea): una consegna avvenuta con questo valore < 100% è passata (anche) per contatti opportunistici. "Airtime LoRa" = tempo di trasmissione LoRa consumato da tutti i file, tutte le copie. Varianti: ${Object.entries(VARIANTS).map(([k, v]) => `${k} = ${v}`).join("; ")}.`);

console.log(out.join("\n"));
