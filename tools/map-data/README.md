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

Serve la rete la prima volta; poi l'analisi legge dalla cache (`ARALD_TILE_CACHE` o `~/.cache/arald-design-tool/tiles`, tetto 1,5 GB). Una configurazione con `"terrain": "world"` usa queste tessere. File: `geo-tile.ts` (in `tools/scenario-model/`, formato e `TileTerrain`), `png.ts`, `terrarium.ts` (quote), `worldcover-source.ts` + `geo-cover.ts` (suolo), `tile-builder.ts` (costruzione), `tile-cache.ts` (deposito su disco e tetto), `world.ts` (tessere per una configurazione), `build-tiles.mts` (comando). Test: `tests/unit/world-tiles.test.ts`. Dettagli e confronto con i pacchetti: `docs/real-maps.md`.
