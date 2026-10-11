# Mappe e terreno reale

Stato: **fase 1 di 4 completata** (11 ottobre 2026). Obiettivo: far girare il motore di `tools/scenario-model/` su terreno vero (quote e uso del suolo) invece che sintetico, poi mostrarlo nella pagina del tool (`tools/network-design/`), poi completare l'editing dei dispositivi, poi preparare le aree Italia e Alpi europee.

## Cosa è stato fatto (fase 1: dati e motore)

Un **pacchetto di terreno** è una griglia in metri locali (celle da 100 m) con quota e classe d'uso del suolo, preparata da dati aperti con `npm run map-data`. `PackTerrain` (`tools/scenario-model/terrain-pack.ts`) implementa la stessa interfaccia `Terrain` dei territori sintetici: il motore (link, aloni, resilienza) non è stato toccato. Una configurazione lo usa con `"terrain": "pack:<id>"`; il CLI (`--config`) lo carica da `tools/network-design/data/<id>.pack.gz`.

| Cosa | Fonte | Licenza / attribuzione |
|---|---|---|
| Quota | SRTM 1 arcsecondo (~30 m, NASA/USGS) tramite i "terrain tiles" aperti su AWS | dominio pubblico (NASA), ringraziamento a AWS Terrain Tiles |
| Uso del suolo | ESA WorldCover 2021 v200 (10 m) | CC BY 4.0: «© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium» |

L'attribuzione è scritta dentro ogni pacchetto (`header.attribution`) e va mostrata dove si mostra la mappa.

### Come si prepara un'area

```bash
npm run map-data -- --id valle-maira --name "Alta Valle Maira" --lat 44.45 --lon 6.95 --width-km 50 --height-km 40
```

Serve la rete. Le tessere scaricate stanno in `tools/map-data/.cache/` (ignorata da git) e si riusano. Il pacchetto finisce in `tools/network-design/data/`. Opzioni: `--cell-m` (default 100), `--clutter-relief false`, `--out`, `--allow-sea` (per un'area davvero solo di mare aperto: senza, lo script si ferma se non scarica nessuna tessera di quota, perché lo stesso errore 403/404 lo dà anche una rete o un proxy che negano l'accesso). Rifiuta parametri fuori intervallo, aree oltre 40 milioni di celle e aree che attraversano il limite ±180°. Una dipendenza di sviluppo, `geotiff` (solo per leggere WorldCover; mai nella pagina né nel nodo), `npm audit` non segnala nulla nella sua catena (le vulnerabilità note sono tutte nel toolchain di test già presente).

### Cosa fa lo script

1. **Quota**: media di 3×3 campioni SRTM per cella (ricampionamento bilineare, dato mancante = 0). I valori negativi, cioè i fondali marini che le tessere aperte includono, diventano 0: il livello del mare è la quota minima, quindi polder e delta sotto il livello del mare risultano appiattiti.
2. **Suolo**: per ogni cella da 100 m si contano i pixel WorldCover da 10 m (≈100). Acqua se almeno la metà (anche «nessun dato» = mare aperto), costruito denso dalla metà, abitato dal 15%, bosco dalla metà, altrimenti aperto. **Le soglie sono una scelta di progetto, non una misura.** Coordinate esattamente sul bordo di due tessere SRTM usano la tessera a sud/ovest se quella a nord/est manca.
3. **Formato**: quote come differenze orizzontali a 16 bit, classi a 8 bit, gzip. L'Alta Valle Maira (50×40 km) pesa 237 KB, le Eolie (70×60 km, per lo più mare) 23 KB.

I pacchetti sono input non fidato (un file scelto dall'utente): `decodePack` controlla firma, versione, dimensioni (tetto 40 milioni di celle) e classi prima di allocare.

## Risultati

Pacchetti pronti: `valle-maira` (44,45°N 6,95°E, 50×40 km) e `eolie` (38,6°N 15,05°E, 70×60 km). Controllo di orientamento e scala sulle Eolie: cima dello Stromboli 857–890 m contro 924 m, Punta del Corvo (Panarea) 382 contro 421, Gran Cratere (Vulcano) 373 contro 391 (la media su 100 m e le coordinate approssimate spiegano lo scarto).

### Eolie: lo stesso esempio, terreno sintetico contro reale

`examples/eolie-resilienza.json` (isole sintetiche) contro `examples/eolie-resilienza-reale.json` (stesse coordinate, terreno vero):

| | Sintetico | Reale |
|---|---:|---:|
| Resilience Score | 73 | 45 |
| Collegamenti diretti in rete | 9 | 3 |
| Copertura connessa | 79% | 28% |
| Connettività diretta | 100% | 33% |
| Nodi critici | BOX, FR, PORT | BOX, PORT |

Il Box di Lipari (in porto, 4 m sul livello del mare) non vede più il ripetitore di Panarea (21 km): a 1,8 km dal Box c'è un rilievo di circa 80 m sulla costa nord-est di Lipari, più alto della retta tra le due antenne (≈45 m a quel punto), con perdita per diffrazione di 19,6 dB. I tre collegamenti rimasti sono tutti locali (Box–Card in porto, Portable–Card a Stromboli, ripetitore–Card a Panarea). **Il terreno inventato era troppo clemente**: è un risultato da prendere sul serio, ma con le cautele sotto (posizioni scelte senza rilievo, altezze d'antenna ipotetiche). Attivare `clutterHeightRelief` (di default sì nei pacchetti reali) cambia il punteggio di un solo punto (44 → 45): la causa è la geometria del rilievo, non il suolo.

### Alta Valle Maira (esempio nuovo, `examples/valle-maira-reale.json`)

Sette dispositivi tra Chiappera e il vallone di Stroppia. Resilience Score **66**: il Box e le tre Card vicine si vedono tra loro, mentre il rifugio (C4) e la Card verso il bivacco (C5) non hanno **nessun** collegamento (valle stretta, cresta in mezzo). Servirebbe un ripetitore in quota: è proprio ciò che il tool dovrà far provare. **Le posizioni sono indicative**: lo scenario sintetico (`valle-maira.ts`) usa coordinate locali ricostruite dalle distanze, non rilevate; qui i punti sono stati scelti sul terreno vero tra quelli la cui quota (dal modello) coincide con quella dello scenario (1650/1700/1780/1800/2260/2815 m), vicino a Chiappera. Non sono luoghi verificati su cartografia.

## Limiti (da non dimenticare)

- **Risoluzione**: celle da 100 m. Le creste più strette di ~100 m sono smussate (la media 3×3 le abbassa un po'), quindi i link in cresta tendono a essere appena ottimistici.
- **SRTM è un modello di superficie** (alberi e edifici inclusi, dati del 2000); WorldCover non ha le altezze degli edifici.
- **Nessuna strada, nessun nome**: i dati usati non li contengono (OpenStreetMap non è raggiungibile da questo ambiente). La mappa è topografica, non stradale.
- **Origine locale**: il motore usa una proiezione equirettangolare con l'origine della configurazione; per aree di decine di km l'errore è trascurabile, per centinaia no. Una configurazione con un'origine diversa da quella del pacchetto viene allineata con una semplice traslazione.
- **Fuori dal pacchetto** quota 0 e suolo «mare» (una parete brusca): un dispositivo o un percorso fuori dal riquadro dà risultati inaffidabili. Il CLI lo segnala con un avviso su stderr; la pagina dovrà fare lo stesso.
- **I parametri radio restano ipotesi** (esponente, margine, perdite di clutter): il terreno diventa vero, il risultato resta una stima. Non verificato contro misure.
- Le soglie di classificazione del suolo e i valori di clutter per classe sono scelte di progetto.

## Prossime fasi (ciascuna con ok esplicito)

2. **Pagina**: mappa reale con zoom dall'intera area (panoramica a 1 km) alla valle (100 m), caricamento delle aree sul momento, quota sotto ogni dispositivo e avviso se è in acqua o fuori dal pacchetto, attribuzioni visibili. Da `file://` un browser non carica i file dati: servirà un piccolo server locale (`npm run design-tool:serve`).
3. **Dispositivi**: tavolozza da trascinare, annulla/ripeti, duplica, disegno del percorso di un dispositivo mobile con velocità.
4. **Aree pronte**: Italia (Valle Maira, Dolomiti, Valle d'Aosta/Monte Bianco, Appennino centrale, Eolie) e Alpi europee (Chamonix–Courmayeur–Martigny, Vallese/Zermatt, Engadina, Tirolo, Alpi Giulie), con confronto sintetico/reale documentato.
