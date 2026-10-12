# tools/network-design/

Pagina del **ARALD Network Design Tool**: mappa, dispositivi (tavolozza, spostamento, copia, annulla/ripeti, percorsi dei mobili), aloni di copertura, collegamenti colorati per qualità, pannello connessioni, legenda, test di resilienza (spegni un nodo o un'area, punteggio) e configurazione salvabile come JSON. Obiettivo e requisiti: `docs/network-design-tool.md`.

**Solo interfaccia.** Ogni numero viene dal motore di `tools/scenario-model/` (`assessNetwork`, `coverageGrid`, `prepareResilience`, `evaluateFailure`, `resilienceScore`), che gira nel browser: nessun server, nessun account, nessun dato in uscita.

```bash
npm run design-tool:build     # → dist/index.html (pagina), dist/artifact.html (senza scheletro, per la pubblicazione), dist/data/ (mappe), dist/artifact-data/ (le stesse mappe in base64, solo testo, per la pubblicazione)
npm run design-tool:serve     # costruisce e serve su http://127.0.0.1:8470/ (--port per cambiarla): serve per le mappe reali; serve anche le tessere del mondo (`--no-tiles` per spegnerle, `--tile-cache <cartella>`, `--cap-gb` 1,5, `--max-new-per-hour` 400)
```

Aperta con un doppio clic (`file://`) la pagina funziona con i soli esempi sintetici: il browser non scarica i file dati delle mappe reali (`docs/real-maps.md`).

- `world-tiles.ts` — tessere del mondo nel browser (scarico a richiesta dal server locale, limiti e memoria). `packs.ts` — catalogo e caricamento dei pacchetti di terreno (scarico, gzip, validazione). `serve.mjs`/`serve-lib.mjs` — server locale: file statici più `/tiles/<tx>/<ty>` e `/tiles/status` (solo con l'intestazione della pagina; gira con `tsx`, vedi `docs/real-maps.md`). `data/` — pacchetti pronti e `index.json` (`npm run map-data:index`).
- `history.ts` — storico annulla/ripeti. `route.ts` — dalla bozza di percorso (tappe, soste, velocità) al `route` della configurazione e ritorno.
- `logic.ts` — logica pura (vista sulla mappa, colori, modifica della configurazione): testata in `tests/unit/network-design-logic.test.ts`.
- `app.ts` — interfaccia (canvas + pannello). `index.template.html` — struttura e stile (tema chiaro/scuro). `build.mjs` — impacchetta tutto con esbuild.
- Controllo dei tipi: `npx tsc -p tools/network-design/tsconfig.json`.

**Stato: esempio dimostrativo, interno.** Terreni sintetici (Eolie, Atacama, Kampala) e parametri radio non verificati: non è una previsione. La pagina non è linkata da `site/`, dai portali né dall'app; dove pubblicarla è una decisione aperta (`docs/next-steps.md`).

**Limiti:** una sola area reale alla volta, nessuna strada né nomi di luogo; un dispositivo con percorso (es. l'aliscafo) è mostrato alla partenza; la resilienza usa i pesi di default e il guasto d'area è un cerchio; niente Network Optimizer (prossimo passo).

Ospitata anche dal Mirror Portal (`/strumento-rete`, dietro login) come copia generata: dopo ogni modifica alla pagina, al motore o ai pacchetti lancia `npm run design-tool:mirror-sync` e committa `mirror-portal/design-tool/` (il test `tests/unit/mirror-portal-design-tool.test.ts` fallisce se la copia è obsoleta).
