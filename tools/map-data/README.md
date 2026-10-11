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
