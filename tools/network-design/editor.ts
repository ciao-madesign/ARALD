/**
 * Regole di modifica della rete, senza interfaccia: ogni modifica registra lo stato precedente (annulla/ripeti),
 * un trascinamento è un solo passo e viene scartato se nel frattempo la rete è cambiata per un'altra via
 * (annulla, altra modifica, cambio di scenario). Gli stati sono immutabili (la configurazione), così lo storico
 * può tenerne riferimenti senza copiarli.
 */
import { History } from "./history.js";

/** Passaggio da un trascinamento: lo stato di partenza e il "momento" (epoca) in cui è iniziato. */
export interface MoveToken<T> { before: T; epoch: number }

export class Editor<T> {
  private readonly hist: History<T>;
  private epoch = 0;

  constructor(limit = 100) {
    this.hist = new History<T>(limit);
  }

  get canUndo(): boolean { return this.hist.canUndo; }
  get canRedo(): boolean { return this.hist.canRedo; }

  /** Nuova rete (caricata da un altro scenario o da un file): azzera lo storico e annulla i trascinamenti in corso. */
  reset(): void {
    this.hist.reset();
    this.epoch++;
  }

  /** Modifica `current` → `next`: registra `current`. Restituisce `next` (o `current` se non è cambiato nulla). */
  commit(current: T, next: T): T {
    if (next === current) return current;
    this.hist.push(current);
    this.epoch++;
    return next;
  }

  undo(current: T): T {
    if (!this.hist.canUndo) return current;
    this.epoch++;
    return this.hist.undo(current);
  }

  redo(current: T): T {
    if (!this.hist.canRedo) return current;
    this.epoch++;
    return this.hist.redo(current);
  }

  /** Inizio di un trascinamento (la rete cambia a ogni movimento, lo storico solo alla fine). */
  beginMove(current: T): MoveToken<T> {
    return { before: current, epoch: this.epoch };
  }

  /** Il trascinamento vale ancora (non è successo altro dall'inizio)? */
  isCurrent(token: MoveToken<T>): boolean {
    return token.epoch === this.epoch;
  }

  /** Fine di un trascinamento: se vale ancora e la rete è cambiata, è un solo passo annullabile. Restituisce se ha registrato. */
  endMove(token: MoveToken<T>, current: T): boolean {
    if (!this.isCurrent(token) || current === token.before) return false;
    this.hist.push(token.before);
    this.epoch++;
    return true;
  }
}
