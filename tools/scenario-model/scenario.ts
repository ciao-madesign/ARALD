/**
 * Contratto comune di uno scenario: `cli.ts` e `model.ts` non conoscono nessuno
 * scenario specifico, ogni scenario è un file che esporta un oggetto `Scenario`.
 */
import type { Environment, Message, NodeSpec, RegulatoryProfile } from "./model.js";

export interface Scenario {
  id: string;
  title: string;
  /** Variante di mobilità/evento → descrizione breve. */
  variants: Record<string, string>;
  environments: Record<string, Environment>;
  buildNodes(variant: string): NodeSpec[];
  messages(): Message[];
  /** Istante (s) di generazione dei file benchmark. */
  eventT: number;
  /** Perdita aggiuntiva dipendente dal tempo per una variante (es. perturbazione), se presente. */
  extraLossDb?(variant: string): ((t: number) => number) | undefined;
  /** Coppie di nodi da mostrare nella tabella dei link, e la variante da cui leggerne le posizioni. */
  linkPairs: [string, string][];
  linkSnapshotVariant: string;
  /** Coppia sorgente→destinazione di cui riportare la connettività istantanea. */
  connectivityPair: [string, string];
  /**
   * Profili regolatori da confrontare nelle tabelle (etichetta, profilo). Default: EU868 g1 e g3.
   * Uno scenario fuori dall'Europa indica quelli della propria regione.
   */
  regulatoryProfiles?: [string, RegulatoryProfile][];
  /** Modello BLE/Wi-Fi: "fixed" (default, Scenari 1-2) o "budget" (link budget a 2,4 GHz). */
  shortRangeModel?: "fixed" | "budget";
}
