# tools/map-data/

Preparazione dei **pacchetti di terreno reale** (quota SRTM + uso del suolo ESA WorldCover) usati dal motore di `tools/scenario-model/` e dalla pagina del tool. Spiegazione, licenze, risultati e limiti: `docs/real-maps.md`.

```bash
npm run map-data -- --id valle-maira --name "Alta Valle Maira" --lat 44.45 --lon 6.95 --width-km 50 --height-km 40
```

- `build-pack.mts` — scarica le tessere (cache in `.cache/`, ignorata da git), ricampiona e scrive `tools/network-design/data/<id>.pack.gz`. Serve la rete.
- `sources.ts` — nomi/indirizzi delle tessere e lettura del formato SRTM (puro).
- `resample.ts` — dalla tessera grezza alla griglia in metri locali, classi d'uso del suolo (puro, testato).
- `load.ts` — lettura dei pacchetti da disco per il CLI (`"terrain": "pack:<id>"`), con controllo dell'identificativo.

Test: `tests/unit/real-terrain.test.ts`. Dipendenza di sviluppo: `geotiff` (solo qui).

## Terreno del mondo a tessere

```bash
npm run map-tiles -- --config tools/scenario-model/examples/eolie-resilienza-reale.json   # le tessere che servono a una rete (margine 30 km)
npm run map-tiles -- --bbox 44.2,6.6,44.7,7.3                                             # oppure un riquadro geografico
```

Serve la rete la prima volta; poi l'analisi legge dalla cache (`ARALD_TILE_CACHE` o `~/.cache/arald-design-tool/tiles`, tetto 1,5 GB). Una configurazione con `"terrain": "world"` usa queste tessere. File: `geo-tile.ts` (in `tools/scenario-model/`, formato e `TileTerrain`), `png.ts`, `terrarium.ts` (quote), `worldcover-source.ts` + `geo-cover.ts` (suolo), `tile-builder.ts` (costruzione), `tile-cache.ts` (deposito su disco e tetto), `tile-service.ts` (servizio di tessere del server locale: cache, costruzione al bisogno, limiti), `world.ts` (terreno del mondo dalla cache per il CLI; tessere e avvisi in `tools/scenario-model/world-area.ts`), `build-tiles.mts` (comando: `--config`/`--bbox`, `--margin-km` 30, `--cache-dir`, `--max-new` 800, `--concurrency` 4, `--cap-gb` 1,5), `compare-pack.mts` (confronto delle tessere con un pacchetto: `ARALD_TILE_CACHE=<cartella> npx tsx tools/map-data/compare-pack.mts`; le cifre di `docs/real-maps.md` vengono da qui, con la rete). Test: `tests/unit/world-tiles.test.ts`, `tests/unit/tile-service.test.ts`. Dettagli e confronto con i pacchetti: `docs/real-maps.md`.
