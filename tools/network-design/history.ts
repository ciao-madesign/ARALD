/**
 * Storico annulla/ripeti per stati immutabili (la configurazione della rete). Ogni modifica registra lo
 * stato precedente; annullare restituisce quello e rende ripetibile il successivo. Una nuova modifica
 * dopo un annullamento elimina il ramo che si poteva ripetere. Il numero di stati è limitato.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(private readonly limit = 100) {
    if (!(limit >= 1)) throw new Error("History: il limite deve essere almeno 1");
  }

  /** Registra `before` come stato da cui si è partiti con una modifica (non lo registra se è già l'ultimo). */
  push(before: T): void {
    if (this.past.length > 0 && this.past[this.past.length - 1] === before) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** Stato precedente; `current` diventa ripetibile. Senza passato restituisce `current`. */
  undo(current: T): T {
    const prev = this.past.pop();
    if (prev === undefined) return current;
    this.future.push(current);
    return prev;
  }

  /** Stato successivo annullato; `current` torna annullabile. Senza futuro restituisce `current`. */
  redo(current: T): T {
    const next = this.future.pop();
    if (next === undefined) return current;
    this.past.push(current);
    return next;
  }

  reset(): void {
    this.past = [];
    this.future = [];
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }
}
