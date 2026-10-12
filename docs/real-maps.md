# Mappe e terreno reale

Stato: **fasi 1, 2 e 3 di 4 completate** (11-12 ottobre 2026); l'area ampia senza limiti è la richiesta successiva (vedi in fondo). Obiettivo: far girare il motore di `tools/scenario-model/` su terreno vero (quote e uso del suolo) invece che sintetico, poi mostrarlo nella pagina del tool (`tools/network-design/`), poi completare l'editing dei dispositivi, poi preparare le aree Italia e Alpi europee.

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
- **Come si apre**: da una pagina aperta con `file://` il browser non scarica i file dati; `npm run design-tool:serve [-- --port 8470]` costruisce la pagina e la serve su `http://127.0.0.1:8470/` (solo 127.0.0.1; `serve-lib.mjs` rifiuta i percorsi fuori da `dist/`, i collegamenti simbolici che ne escono e le richieste con un `Host` diverso da quello locale contro il DNS rebinding, e manda una Content-Security-Policy). Aperta da `file://` la pagina funziona lo stesso ma con i soli esempi sintetici e un avviso. Pubblicata come Artifact (che serve solo file di testo, non `.gz`), la build produce anche `dist/artifact-data/`: gli stessi pacchetti in base64 (`<id>.pack.gz.b64.txt`) con un catalogo che li indica, da pubblicare come `data/` accanto a `dist/artifact.html`.

Limiti della fase 2: un'area alla volta (nessuna panoramica su più aree, arriva con la fase 4); serve un browser recente (`DecompressionStream`); un dispositivo trascinato fuori dall'area dà risultati inaffidabili ma non viene impedito (l'avviso lo dice); il rilievo ombreggiato è calcolato dalle celle da 100 m e non mostra dettagli più fini.

## Fase 3: editing dei dispositivi (12 ottobre 2026)

Sulla pagina si possono aggiungere, spostare, copiare, cambiare e togliere dispositivi, con annulla/ripeti, e disegnare il percorso di un mobile:

- **Tavolozza** (barra «Aggiungi»): Box, Portable, Fixed Relay, Card, Smartphone. Si fa clic sul tipo e poi sulla mappa (funziona anche da telefono, e si può aggiungerne più d'uno; Esc finisce), oppure si trascina il tipo sulla mappa. Elenco dei dispositivi nel pannello per sceglierne uno anche quando sono sovrapposti.
- **Dispositivo selezionato**: tipo (cambiabile), nome, altezza dell'antenna, **Duplica** (copia vicina, con il percorso se c'è), **Rimuovi**.
- **Annulla / Ripeti** (pulsanti, Ctrl+Z, Ctrl+Maiusc+Z o Ctrl+Y): fino a 100 passi. Coprono aggiunte, spostamenti (un trascinamento è un solo passo), rimozioni, copie, tipo/nome/altezza, ambiente e normativa, percorsi. Non coprono i guasti simulati, né la scelta di un altro scenario (che azzera lo storico). Le modifiche non alterano mai l'oggetto precedente: lo storico conserva copie.
- **Percorso di un mobile** («Disegna percorso»): clic sulla mappa per le tappe, mezzo (a piedi 4, bicicletta 15, auto 40, barca 25, aliscafo 60, elicottero 150 km/h, oppure velocità libera), «parte dopo» N minuti, sosta in minuti a ogni tappa, orari di arrivo calcolati a velocità costante e lunghezza totale. Invio termina, Esc annulla. Si può rimodificare («Modifica percorso») o togliere («Rendi fisso»). La posizione fissa del dispositivo segue la partenza. Il percorso entra nell'analisi di resilienza (contatti opportunistici); sulla mappa il dispositivo resta alla partenza e il percorso è tratteggiato.

Mentre si disegna un percorso la scheda mostra solo l'editor: una modifica (copia, rimozione, ambiente…) lo interromperebbe; cambiare scheda, premere Esc, scegliere un altro strumento lo annullano; «Fine» senza cambiare nulla non aggiunge un passo allo storico. Durante un trascinamento le linee dei collegamenti seguono il dispositivo, la qualità si aggiorna al rilascio. Un trascinamento interrotto da altro (annulla, nuovo scenario) non registra nulla.

Limiti: velocità costante (nessun rallentamento, attese solo dove le indichi), nessun cursore del tempo per vedere i mobili muoversi, le tappe non si trascinano (si tolgono con × e si rifanno), due tappe a meno di 0,5 m si fondono in una sosta quando si ricarica un percorso per modificarlo, i guasti simulati non sono nello storico.

## Area ampia: terreno del mondo a tessere (richiesta del 12 ottobre 2026)

Un pacchetto copre un riquadro fisso preparato in anticipo. Per un'area non limitata il terreno è diviso in **tessere del mondo** caricate quando servono. Scelte concordate con l'utente: scarica il **server locale** (non il browser; serve Internet su quel computer), niente panoramica nell'Artifact (che resta con Valle Maira ed Eolie), celle da circa 100 m, riferimento locale ricentrato sulla rete con avviso oltre 300 km, cache su disco con tetto di 1,5 GB, mondo intero con avviso oltre i 60° di latitudine.

**Fasi 1, 2 e 3 fatte (12 ottobre 2026): formato, terreno nel motore, generatore; servizio di tessere nel server locale; pagina senza bordi.**

- **Griglia** (`tools/scenario-model/geo-tile.ts`): celle geografiche regolari di 0,25°/256 (≈ 108,6 m in latitudine; in longitudine 108,6 m all'equatore, 77 m a 45°, 54 m a 60°), tessere da 256×256 celle (0,25° di lato). Tessere valide entro 85° di latitudine. Una tessera pesa circa 20-70 KB compressa.
- **`TileTerrain`** implementa `Terrain` leggendo da un deposito di tessere già caricate (lettura sincrona: il motore non cambia). Quota con interpolazione bilineare anche a cavallo di due tessere; una tessera mancante dà quota 0 e «mare» ed è registrata (`missingTiles()`), così chi analizza sa se i risultati valgono.
- **Fonti aperte**: quote dalle tessere Terrarium di AWS (SRTM e altre fonti, zoom 10, ≈ 108 m a 45°; PNG decodificato con un decodificatore scritto da zero, solo `node:zlib`); uso del suolo da ESA WorldCover (CC BY 4.0) letto dal livello di sintesi più grossolano il cui pixel è almeno metà cella (~750×750 pixel per tessera, a intervalli di byte). Stesse classi e soglie dei pacchetti.
- **Generatore** `npm run map-tiles -- --config file.json` (o `--bbox sud,ovest,nord,est`): costruisce solo le tessere che mancano, quattro alla volta, scrive in modo atomico e tiene la cache sotto il tetto eliminando le meno recenti. Cache in `ARALD_TILE_CACHE` o `~/.cache/arald-design-tool/tiles`.
- **CLI**: `"terrain": "world"` in una configurazione legge dalla cache (non scarica nulla, funziona offline); senza le tessere necessarie dice quante mancano e il comando per prepararle.
- **Tessere mai «piatte» per errore di rete**: una quota assente dove il suolo dice che c'è terra, o un suolo assente dove le quote dicono che c'è terra, è un errore e non si scrive nulla (lo stesso 403/404 lo danno anche un proxy o una rete che negano l'accesso).

**Confronto con i pacchetti** (stessi dati d'ingresso, fonti diverse): Alta Valle Maira, 28 mila punti, errore medio assoluto sulla quota 8,9 m, bias −0,7 m, scarto quadratico 12 m, massimo 153 m (cresta), suolo uguale nel 93% dei punti e stessa distribuzione di classi; Resilience Score 66/100 identico, un collegamento in più (C4–C5, SF12, 1,2 km, qualità debole). Eolie reali: 45/100 identico. Tempi: 16 tessere (~27×20 km ciascuna, area 108×80 km) in 7 s, 25 tessere in 10 s; 41 tessere in cache pesano 1,5 MB (il mare si comprime molto).

Limiti: le quote Terrarium a zoom 10 sono più lisce dell'SRTM a 30 m (creste strette abbassate), oltre i 60° nord le quote non vengono da SRTM, nessuna strada né nome di luogo, la proiezione locale sbaglia le distanze di qualche percento oltre 300 km (avviso), dipendenza da servizi aperti di terzi (AWS Open Data, ESA) che possono cambiare.

Prossime fasi dell'area ampia (ciascuna con ok): 2) servizio di tessere nel server locale con cache e download con limiti; 3) pagina senza bordi con caricamento al volo, indicatore e «vai a coordinate»; 4) documenti e revisione finale. La vecchia fase 4 «aree pronte» è assorbita da un elenco di luoghi da cui partire.

**Fase 2: servizio di tessere nel server locale** (`tools/map-data/tile-service.ts`, collegato in `serve-lib.mjs`/`serve.mjs`). `GET /tiles/<tx>/<ty>` dà la tessera compressa (gzip del formato ARTG) dalla cache o, se manca, la costruisce al momento da Terrarium + WorldCover; `GET /tiles/status` dà lo stato della cache. Il browser non contatta mai le fonti: scarica solo dal server locale. Opzioni di `npm run design-tool:serve`: `--no-tiles` (spento), `--tile-cache <cartella>`, `--cap-gb` (default 1,5), `--max-new-per-hour` (default 400); la cartella predefinita è `~/.cache/arald-design-tool/tiles`.
- **Limiti ai download**: al più 4 costruzioni insieme, coda di 64, 400 tessere nuove all'ora (oltre: errore 429 con `Retry-After` e il suggerimento di usare `npm run map-tiles`), 100 tentativi falliti all'ora (una fonte che non risponde non si martella), 180 s al massimo per tessera, cache sotto 1,5 GB con eliminazione delle meno recenti (mai quelle servite negli ultimi 10 minuti). Richieste uguali contemporanee condividono una sola costruzione.
- **Errori chiari**: 404 tessera fuori dal mondo (oltre ±85°), 429 limiti, 502 fonti non raggiungibili o senza dati; mai una tessera di «mare» salvata per un errore.
- **Difesa**: le richieste di tessere devono portare l'intestazione `X-ARALD-Tool: 1` (e, se presenti, `Origin` uguale all'`Host` e `Sec-Fetch-Site: same-origin`); un altro sito non può aggiungerla senza una richiesta di verifica CORS, a cui il server non risponde mai. Si somma al controllo `Host` contro il DNS rebinding.
- `npm run design-tool:serve` ora gira con `tsx` (il servizio è TypeScript); con `node serve.mjs --no-tiles` il server statico funziona anche senza.
- Verificata con la rete reale: tre tessere (due in Valle Maira e una in oceano) in 4,1 s la prima e 0,4-0,6 s le successive, poi servite dalla cache.

**Fase 3: la pagina senza bordi** (`tools/network-design/world-tiles.ts`, `app.ts`). Una rete con `"terrain": "world"` non ha più un'area limitata: la pagina chiede al server locale (`tiles/<tx>/<ty>`) le tessere che servono e il resto resta «in caricamento» (scacchi neutri) finché non arriva.
- **Esempi**: «Alta Valle Maira — terreno del mondo» (stesso risultato del pacchetto: Resilience Score 66/100), «Eolie con aliscafo — terreno del mondo» e «Nuova rete nel mondo — terreno reale». Le voci sono disattivate se la pagina è aperta da `file:` o con `--no-tiles`.
- **Caricamento a richiesta**: all'apertura di una rete si caricano le tessere dell'area dei dispositivi e dei percorsi (con 30 km di margine, al massimo 250); a ogni spostamento o zoom (dopo una pausa di 200 ms) si caricano quelle che la vista mostra (al massimo 80: oltre, l'indicatore chiede di avvicinare). Se si trascina o si aggiunge un dispositivo in una zona non ancora caricata, le tessere arrivano e i calcoli si rifanno da soli. Un indicatore in basso a sinistra mostra il progresso (`Carico il terreno… 3/9`), o l'errore del server (per esempio il tetto orario di tessere nuove) senza riprovare per 20 s. Nel browser si tengono al massimo 500 tessere (~100 MB): mai scartate quelle della rete e della vista.
- **Vai a coordinate**: il campo «Vai a» accetta `46.5, 8.0`, `46.5 8.0`, `46,5; 8,0` (latitudine tra −85° e 85°). «Vai» sposta la mappa; «Nuova rete qui» comincia una rete vuota con terreno reale in quel punto (chiede conferma se ci sono modifiche).
- **Ricentrare il riferimento**: le coordinate dei dispositivi sono geografiche, ma i calcoli usano metri locali da un'origine; oltre 300 km dall'origine le distanze sbagliano di qualche percento. «Vai» a un punto lontano sposta l'origine lì solo se nessun dispositivo o tappa di percorso resta oltre 300 km dal nuovo centro; altrimenti la mappa si sposta comunque e compare l'avviso «la vista è a N km dalla rete…» con il suggerimento di «Nuova rete qui». Con la vista lontana ma ricentrabile compare «Ricentra qui». Ricentrare azzera la cronologia annulla/ripeti (descrive la rete con il vecchio riferimento) e converte le aree di guasto.
- **Avvisi**: sopra 60° di latitudine («le quote non vengono da SRTM»), oltre 300 km di larghezza, oltre 85° nessun dato; sempre l'attribuzione delle fonti sotto la mappa.
- **Limiti**: serve `npm run design-tool:serve` con la rete (il browser non scarica dalle fonti, il server sì); la pubblicazione come Artifact non può offrire il terreno del mondo (nessun server): lì restano i pacchetti; sotto circa 250 m/px (una vista di più di 80 tessere) il terreno non si carica; tra le tessere e il resto della rete le distanze sono quelle della proiezione locale (vedi sopra); l'orientamento è sempre il nord in alto.


## Prossime fasi (ciascuna con ok esplicito)

4. **Aree pronte** (assorbita dall'area ampia): Italia (Valle Maira, Dolomiti, Valle d'Aosta/Monte Bianco, Appennino centrale, Eolie) e Alpi europee (Chamonix–Courmayeur–Martigny, Vallese/Zermatt, Engadina, Tirolo, Alpi Giulie), con confronto sintetico/reale documentato, e una panoramica a risoluzione ridotta per scegliere l'area. Verrà ripensata alla luce dell'area ampia.
