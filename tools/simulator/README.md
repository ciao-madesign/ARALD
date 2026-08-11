# tools/simulator/

Simulatore di rete in-process (roadmap milestone 20, spec §76-80): collega N istanze reali di `NomadNode` in una topologia configurabile (catena, anello, stella, casuale) ed esegue lo scenario "content fanout" — un nodo pubblica un contenuto, tutti gli altri lo richiedono attraverso la mesh — misurando percentuale di consegna e latenza.

- `simulate.ts` — logica riutilizzabile (`runSimulation()`), usata sia dal CLI sia da `tests/network/simulate.test.ts`.
- `cli.ts` — interfaccia a riga di comando.

Uso:

```bash
npm run simulate -- --nodes 50 --topology random --extra-links 20
```

Opzioni principali: `--nodes`, `--topology` (`chain`/`ring`/`star`/`random`), `--extra-links` (solo per `random`), `--content-size`, `--timeout`, `--ttl`, `--rate-limit`. Vedi `docs/roadmap.md` milestone 20 per il dettaglio, incluso un bug reale nel transport TCP scoperto durante lo sviluppo di questo strumento.

Non ancora coperto: scenari con packet loss artificiale o nodi che si spostano fisicamente durante l'esecuzione (§80) — vedi `tests/network/README.md`. `tools/benchmark/` resta non implementato.
