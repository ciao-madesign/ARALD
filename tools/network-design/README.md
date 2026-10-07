# tools/network-design/

Pagina del **ARALD Network Design Tool**: mappa, dispositivi spostabili, aloni di copertura, collegamenti colorati per qualità, pannello connessioni, legenda, test di resilienza (spegni un nodo o un'area, punteggio) e configurazione salvabile come JSON. Obiettivo e requisiti: `docs/network-design-tool.md`.

**Solo interfaccia.** Ogni numero viene dal motore di `tools/scenario-model/` (`assessNetwork`, `coverageGrid`, `prepareResilience`, `evaluateFailure`, `resilienceScore`), che gira nel browser: nessun server, nessun account, nessun dato in uscita.

```bash
npm run design-tool:build     # → tools/network-design/dist/index.html (file unico, si apre con un doppio clic)
```

- `logic.ts` — logica pura (vista sulla mappa, colori, modifica della configurazione): testata in `tests/unit/network-design-logic.test.ts`.
- `app.ts` — interfaccia (canvas + pannello). `index.template.html` — struttura e stile (tema chiaro/scuro). `build.mjs` — impacchetta tutto con esbuild.
- Controllo dei tipi: `npx tsc -p tools/network-design/tsconfig.json`.

**Stato: esempio dimostrativo, interno.** Terreni sintetici (Eolie, Atacama, Kampala) e parametri radio non verificati: non è una previsione. La pagina non è linkata da `site/`, dai portali né dall'app; dove pubblicarla è una decisione aperta (`docs/next-steps.md`).

**Limiti della prima versione:** nessuna mappa reale (sfondo disegnato dal terreno sintetico), nessun import di rilievi; un dispositivo con percorso (es. l'aliscafo) è mostrato alla partenza; la resilienza usa i pesi di default e il guasto d'area è un cerchio; niente Network Optimizer (prossimo passo).
