import { readFileSync, statSync } from "node:fs";

/**
 * Da dove arriva la password di rete del nodo. `--network-password <valore>` la lascia visibile in `ps`,
 * `systemctl status` e (stampata all'avvio) nel journal di systemd: per un Box consegnato si preferisce
 * `--network-password-file <percorso>` (file con permessi ristretti) o la variabile d'ambiente
 * `ARALD_NETWORK_PASSWORD` (docs/security.md voce #146, candidato «password in chiaro»).
 */
export type NetworkPasswordSource = "flag" | "file" | "env";

export interface ResolvedNetworkPassword {
  password: string;
  source: NetworkPasswordSource;
  /** Avvisi da mostrare all'operatore (permessi del file troppo larghi, password sulla riga di comando). */
  warnings: string[];
}

export interface NetworkPasswordInputs {
  flag?: string;
  file?: string;
  env?: string;
  readFile?: (path: string) => string;
  /** Permessi (`mode`) del file; `undefined` se non determinabili. Iniettabile per i test. */
  fileMode?: (path: string) => number | undefined;
  platform?: NodeJS.Platform;
}

/** Password scelta tra flag, file e variabile d'ambiente; `undefined` se nessuna è impostata. Lancia se due sono impostate insieme o se il file è vuoto/illeggibile. */
export function resolveNetworkPassword(inputs: NetworkPasswordInputs): ResolvedNetworkPassword | undefined {
  const flag = inputs.flag !== undefined && inputs.flag !== "true" ? inputs.flag : undefined; // «--network-password» senza valore non è una password
  const env = inputs.env !== undefined && inputs.env !== "" ? inputs.env : undefined;
  if (inputs.flag === "") throw new Error("--network-password è vuota (variabile di shell non espansa?)");
  // flag e file sono scelte esplicite sulla riga di comando: insieme sono ambigue. La variabile d'ambiente è la più debole
  // (può essere ereditata dall'ambiente): flag e file la sostituiscono senza errore.
  if (flag !== undefined && inputs.file !== undefined) {
    throw new Error("la password di rete è impostata sia con --network-password sia con --network-password-file: usarne uno solo");
  }
  if (inputs.file !== undefined) {
    const read = inputs.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    let raw: string;
    try {
      raw = read(inputs.file);
    } catch (err) {
      throw new Error(`--network-password-file: impossibile leggere ${inputs.file} (${(err as Error).message})`);
    }
    if (raw.includes("\0")) throw new Error(`--network-password-file: ${inputs.file} non è testo UTF-8 (UTF-16 da PowerShell?): salvarlo come UTF-8`);
    const password = raw.replace(/^\uFEFF/, "").replace(/\r?\n$/, ""); // senza BOM e con un solo a-capo finale, come scrive `echo`
    if (password.trim() === "") throw new Error(`--network-password-file: ${inputs.file} è vuoto`);
    const warnings: string[] = [];
    const mode = inputs.fileMode ? inputs.fileMode(inputs.file) : safeMode(inputs.file);
    if ((inputs.platform ?? process.platform) !== "win32" && mode !== undefined && (mode & 0o077) !== 0) {
      warnings.push(`${inputs.file} è leggibile da altri utenti (permessi ${(mode & 0o777).toString(8)}): meglio chmod 600`);
    }
    return { password, source: "file", warnings };
  }
  if (flag !== undefined) {
    return { password: flag, source: "flag", warnings: ["la password sulla riga di comando è visibile in ps e nel journal di systemd: meglio --network-password-file o ARALD_NETWORK_PASSWORD"] };
  }
  if (env !== undefined) return { password: env, source: "env", warnings: [] };
  return undefined;
}

function safeMode(path: string): number | undefined {
  try {
    return statSync(path).mode;
  } catch {
    return undefined;
  }
}
