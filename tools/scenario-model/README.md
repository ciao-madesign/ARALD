# tools/scenario-model/

Modello **teorico e parametrico** di efficienza della rete ARALD: grafo dinamico \(G(t)\) con link budget LoRa (formula time-on-air Semtech, duty-cycle legale EU868), BLE/Wi-Fi a corto raggio, mobilità dei nodi e store-and-forward. Nessun `NomadNode` reale (per quello c'è `tools/simulator/`) e nessun valore misurato: tutti i parametri sono ipotesi dichiarate.

- `model.ts` — motore (fisica radio, scelta dello SF, simulazione a passo discreto con code, priorità e duty-cycle).
- `valle-maira.ts` — Scenario 1, alta Valle Maira (12 dispositivi, 4 varianti di mobilità, 3 ambienti).
- `cli.ts` — stampa i risultati in Markdown.

```bash
npm run scenario-model
npm run scenario-model -- --max-sf 10 --horizon-h 24
```

Risultati, ipotesi e limiti: `docs/scenario-simulation.md`. Test: `tests/unit/scenario-model.test.ts`.
