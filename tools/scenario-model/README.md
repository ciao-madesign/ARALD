# tools/scenario-model/

Modello **teorico e parametrico** di efficienza della rete ARALD: grafo dinamico \(G(t)\) con link budget LoRa (formula time-on-air Semtech, duty-cycle legale EU868), BLE/Wi-Fi a corto raggio, mobilità dei nodi e store-and-forward. Nessun `NomadNode` reale (per quello c'è `tools/simulator/`) e nessun valore misurato: tutti i parametri sono ipotesi dichiarate.

- `model.ts` — motore (fisica radio, scelta dello SF, simulazione a passo discreto con code, priorità e duty-cycle).
- `scenario.ts` — contratto comune di uno scenario.
- `valle-maira.ts` — Scenario 1, alta Valle Maira (12 dispositivi, 4 varianti di mobilità, 3 ambienti).
- `alpino-frammentato.ts` — Scenario 2, due valli separate da una cresta (terreno per zone, Fixed Relay al colle, perturbazione, guasto del Box).
- `terrain.ts` — territorio interrogabile (`Terrain`: quota e uso del suolo), coordinate geografiche ↔ locali, diffrazione sul profilo, clutter; terreno sintetico a isole.
- `assess.ts` — interrogazione per il futuro tool: `assessLink()` (A in X, B in Y → tecnologia, velocità, qualità) e `coverageGrid()` (alone per tecnologia).
- `network-config.ts` — configurazione salvabile (`NetworkConfig`), validazione, `assessNetwork()`; esempi in `examples/`.
- `eolie.ts` — Scenario 3, Isole Eolie (rete tra isole, aliscafo come data mule, Fixed Relay su Panarea).
- `atacama.ts` — Scenario 4, deserto di Atacama (distanze lunghe, fuoristrada come data mule, banda 915-928 MHz con dwell time).
- `kampala.ts` — Scenario 5, Kampala (città densa su colline, blackout, corriere in boda-boda, Box sul tetto o a terra).
- `resilience.ts` — Test Network Resilience: guasti (nodi, aree, ostacoli), connettività diretta e opportunistica, dipendenze critiche, Resilience Score; nucleo sul grafo + adattatore radio.
- `resilience-report.ts` — testo Markdown dei risultati di resilienza.
- `cli.ts` — stampa i risultati in Markdown.

```bash
npm run scenario-model                                  # Scenario 1
npm run scenario-model -- --scenario alpino-frammentato # Scenario 2
npm run scenario-model -- --scenario eolie --horizon-h 6 # Scenario 3
npm run scenario-model -- --scenario atacama --horizon-h 6 # Scenario 4
npm run scenario-model -- --scenario kampala --horizon-h 6 # Scenario 5
npm run scenario-model -- --config tools/scenario-model/examples/eolie.json [--json]
npm run scenario-model -- --config tools/scenario-model/examples/eolie-resilienza.json --resilience [--fail PORT,C4]   # resilienza
npm run scenario-model -- --max-sf 10 --horizon-h 24
```

Risultati, ipotesi e limiti: `docs/scenario-simulation.md`. Resilienza: `docs/network-resilience.md`. Test: `tests/unit/scenario-model.test.ts`, `tests/unit/scenario-model-tool.test.ts`, `tests/unit/scenario-model-resilience.test.ts`. Obiettivo finale del motore: `docs/network-design-tool.md`.
