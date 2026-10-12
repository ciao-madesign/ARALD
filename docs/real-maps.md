# Mappe e terreno reale

Stato: **fasi 1 e 2 di 4 completate** (11-12 ottobre 2026). Obiettivo: far girare il motore di `tools/scenario-model/` su terreno vero (quote e uso del suolo) invece che sintetico, poi mostrarlo nella pagina del tool (`tools/network-design/`), poi completare l'editing dei dispositivi, poi preparare le aree Italia e Alpi europee.

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

## Fase 2: la mappa reale nella pagina (12 ottobre 2026)

La pagina (`tools/network-design/`) legge i pacchetti e disegna il terreno vero:

- **Catalogo** (`data/index.json`, generato da `npm run map-data:index` e dallo script `map-data`): elenco delle aree con riquadro geografico, dimensione e attribuzione. La pagina lo scarica all'avvio e scarica un'area solo quando la si sceglie (una volta, poi resta in memoria). Catalogo e pacchetti sono input non fidato: vengono validati (identificativo, nome del file, dimensioni, riquadro), il pacchetto scaricato deve corrispondere alla voce di catalogo (stesso identificativo e stessa griglia), anche se un server l'avesse già decompresso, e la decompressione si ferma oltre un tetto di byte. Un'attribuzione mancante nel catalogo è un errore (le licenze la richiedono).
- **Sfondo**: suolo (acqua, aperto, bosco, abitato) con tinta per quota (più chiaro in alto) e rilievo ombreggiato con la luce da nord-ovest. Fuori dall'area dei dati c'è una tinta neutra a scacchi, mai il colore del mare, e il bordo dell'area è tratteggiato; gli aloni di copertura non si disegnano fuori dai dati.
- **Quota sotto ogni dispositivo**: nel pannello, suolo e quota, quota dell'antenna sul livello del mare e avvisi (in acqua per un dispositivo fisso; fuori dall'area dei dati). Un avviso riepilogativo elenca i dispositivi, o i punti di un percorso, fuori dall'area. Passando il cursore sulla mappa si leggono coordinate, quota e suolo.
- **Attribuzioni** sempre visibili in basso a destra (le licenze lo richiedono): per i terreni sintetici la mappa dice che il terreno è di esempio.
- **Esempi**: Alta Valle Maira e Eolie con aliscafo su terreno reale, accanto agli esempi sintetici.
- **Come si apre**: da una pagina aperta con `file://` il browser non scarica i file dati; `npm run design-tool:serve [-- --port 8470]` costruisce la pagina e la serve su `http://127.0.0.1:8470/` (solo 127.0.0.1; `serve-lib.mjs` rifiuta i percorsi fuori da `dist/`, i collegamenti simbolici che ne escono e le richieste con un `Host` diverso da quello locale contro il DNS rebinding, e manda una Content-Security-Policy). Aperta da `file://` la pagina funziona lo stesso ma con i soli esempi sintetici e un avviso. Pubblicata come Artifact, i file `data/` si pubblicano accanto alla pagina.

Limiti della fase 2: un'area alla volta (nessuna panoramica su più aree, arriva con la fase 4); serve un browser recente (`DecompressionStream`); un dispositivo trascinato fuori dall'area dà risultati inaffidabili ma non viene impedito (l'avviso lo dice); il rilievo ombreggiato è calcolato dalle celle da 100 m e non mostra dettagli più fini.

## Prossime fasi (ciascuna con ok esplicito)

3. **Dispositivi**: tavolozza da trascinare, annulla/ripeti, duplica, disegno del percorso di un dispositivo mobile con velocità.
4. **Aree pronte**: Italia (Valle Maira, Dolomiti, Valle d'Aosta/Monte Bianco, Appennino centrale, Eolie) e Alpi europee (Chamonix–Courmayeur–Martigny, Vallese/Zermatt, Engadina, Tirolo, Alpi Giulie), con confronto sintetico/reale documentato, e una panoramica a risoluzione ridotta per scegliere l'area.
