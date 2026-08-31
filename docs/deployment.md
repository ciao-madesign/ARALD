# Deployment

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §8-9, §39-40, §85-86, §103-104.

> Nessuno degli scenari descritti in questo documento è ancora eseguibile in una forma reale/fisica: la logica applicativa di quasi ogni milestone della roadmap (0-7, 12, 13, 15, 16, 20, più i numerosi follow-up in `docs/security.md`) è completa e validata in puro software — store-and-forward, sincronizzazione, cifratura E2E, routing, un gateway NOMAD con più sotto-servizi, un'app mobile, mappe offline, bacheca e chat incluse — ma resta bloccata su forme hardware/Docker/rete reali per le sole milestone 8/9/10/11/14/17/18/19 (BLE fisico, build Android nativa, Project NOMAD via Docker, Wi-Fi Direct, hardware fisico del nodo — vedi [`roadmap.md`](./roadmap.md) per il dettaglio di cosa è bloccato da cosa). Questo documento descrive il *target* di deployment fisico verso cui quel lavoro software è il prerequisito già pronto.

## Principio: nodi infrastrutturali, non "ogni telefono è un router" (§85)

La rete non deve dipendere dalla presenza di migliaia di smartphone sempre attivi come relay. Per ambienti reali devono esistere nodi infrastrutturali fissi (es. in un rifugio: `NODE 1 -> NODE 2 -> NODE 3`); gli smartphone restano nodi opportunistici (client, cache, courier), mai il fondamento dell'infrastruttura.

## Hardware per fase (§9, §86)

| Fase | Hardware | Ruolo |
|---|---|---|
| Prototipo software | Mac / PC | sviluppo, nodo, gateway, simulatore NOMAD tutto sulla stessa macchina |
| Prototipo mobile | Smartphone (Android prioritario, §47) | client, relay opportunistico, courier, cache |
| Nodo permanente | Raspberry Pi | BLE + Wi-Fi + Ethernet, basso consumo, sempre acceso |
| Gateway / NOMAD completo | Mini-PC | AI, cache grandi, orchestrazione Docker di Project NOMAD |
| Futuro/ricerca | Hardware radio dedicato (LoRa) | backbone a lunga distanza, fuori scope MVP (§45) |

Il Raspberry Pi **non** è un prerequisito per iniziare (§9): è un'evoluzione, non un punto di partenza.

## Cosa rende un nodo un "gateway" (§8, §38-40)

Un gateway è una funzione software, non un hardware specifico: qualunque nodo con accesso simultaneo a Nomad-Net e a un'altra rete (tipicamente Internet). Nel primo prototipo può essere semplicemente il computer di sviluppo. Non si assume che uno smartphone sia il gateway nel modello di deployment iniziale (§39) per via di consumo batteria, gestione del background da parte del sistema operativo, NAT e instabilità del processo.

## Il modello a due livelli per un rifugio: gateway + "PC" (discussione con l'utente, 30 agosto 2026)

L'obiettivo preferito dall'utente resta un unico dispositivo tutto-in-uno (gateway + rete + servizi + AI locale sullo stesso oggetto, es. un Orange Pi Zero 2W con Ollama incluso), valutato in dettaglio in chat: la CPU delle schede economiche di questa fascia (Cortex-A53, senza NPU/GPU sfruttabile da Ollama) è probabilmente troppo debole per un LLM realmente usabile in modo interattivo, non solo per limiti di RAM — punto non ancora verificato con un benchmark reale, vedi "Non ancora pianificato in dettaglio" più sotto. **Finché questo non è confermato/smentito con una misura concreta**, il modello a due livelli descritto qui resta il piano B di riferimento, già coerente con §8 e §86 della specifica (un gateway è una funzione software, non necessariamente hardware dedicato; il livello "Mini-PC: NOMAD completo, AI, grandi cache" è già distinto dal livello "Raspberry Pi: nodo permanente" fin dalla prima stesura della specifica).

**Cosa fa il gateway** (es. Orange Pi Zero 2W o un router Wi-Fi con OpenWrt, vedi [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md)): resta acceso 24 ore su 24, crea il Wi-Fi a cui si collegano gli ospiti, fa girare Nomad-Net (routing, cache dei contenuti leggeri, bacheca, mappe, messaggistica), risponde da solo alla quasi totalità delle richieste ordinarie.

**Cosa fa il "PC"** (un mini-PC o computer normale, anche datato — vedi le alternative più economiche sotto): tiene i contenuti pesanti (Kiwix/Wikipedia offline, mappe dettagliate), fa girare Ollama per l'AI locale, e — se il rifugio ha anche una connessione Internet reale — può fare da uscita verso Internet secondo la stessa disciplina già prevista per `service://internet-fetch` (`docs/security.md` voce #45: nessun proxy aperto, allowlist host configurata dall'operatore, rate limiting).

**Dove stanno e come comunicano**: entrambi restano fisicamente al rifugio, sulla stessa rete locale (un cavo o lo stesso Wi-Fi) — non serve mai Internet perché i due si parlino. Il gateway interpella il "PC" solo per le richieste pesanti (una domanda all'AI, un contenuto molto grande); il resto del tempo il "PC" può restare a riposo. Per un ospite con lo smartphone il confine tra i due oggetti è invisibile: si collega a un solo Wi-Fi e vede un solo "Nomad Net del rifugio". Se il "PC" è spento (es. di notte per risparmiare corrente, o un guasto), tutto il resto continua a funzionare — bacheca, mappe, messaggi, contenuti già in cache — solo l'AI e i contenuti che erano *soltanto* sul "PC" non sono disponibili fino a quando non torna acceso.

### Alternative hardware più economiche di "gateway + PC intero"

Valutate in chat il 30 agosto 2026, nessuna ancora scelta come raccomandazione definitiva:

| Opzione | Costo indicativo | Un solo oggetto? | Note |
|---|---|---|---|
| **Gateway con NPU incorporato** (es. Orange Pi 5 / Radxa Rock 5C, chip Rockchip RK3588, 4-8 GB) | 70-110 € | Sì | Più vicino all'idea "tutto in uno"; **ma Ollama non sa usare l'NPU così com'è** — servirebbe il runtime specifico del produttore (RKLLM) e modelli preparati apposta, complessità software reale da valutare, non solo un acquisto diverso |
| **Gateway + mini-PC usato/ricondizionato** (es. un Intel NUC o thin client aziendale dismesso) | 50-100 € per il "PC", più il gateway | No — resta il modello a due livelli, ma la parte cara costa poco | La RAM qui **è davvero espandibile** (slot SO-DIMM reali, a differenza di qualunque SBC economica, dove la RAM è sempre saldata) — un processore x86 anche datato resta più efficiente su carichi come llama.cpp di un Cortex-A53. Stesso Ollama di sempre, nessuna complessità software aggiuntiva |
| **Gateway + accelleratore USB dedicato** (es. Hailo-8) | 100-150 € solo l'accelleratore, più il gateway | Sì | Google Coral **scartato esplicitamente**: pensato per visione artificiale (classificazione immagini), non adatto a un modello di linguaggio. Hailo-8 più adatto in teoria ma il risparmio rispetto alle opzioni sopra si riduce, e resta da configurare/verificare |
| **Solo gateway, AI aggiunta in un secondo momento** | sotto i 100 € oggi | Sì (per ora) | Bacheca, mappe, messaggi, contenuti in cache funzionano comunque da subito; l'AI diventa un pezzo opzionale aggiungibile dopo (con una qualunque delle opzioni sopra), senza dover buttare via nulla di quanto già installato |

## Pilot: rifugio alpino (§103, caso d'uso prioritario §6.2)

Per la componentistica minima e le istruzioni passo passo di installazione/gestione di un singolo nodo fisso (comprensibili anche a un operatore senza competenze informatiche o elettroniche, es. il gestore del rifugio) vedi [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md).

Configurazione target, nei termini del modello a due livelli sopra:

- 1 "PC"/mini-PC per i contenuti pesanti e l'AI locale (il "NOMAD server" — Docker, Debian-based, corrisponde alla "cucina" della spiegazione sopra)
- 1 gateway sempre acceso rivolto agli ospiti (può coincidere fisicamente con il "PC" solo se si verifica che l'hardware scelto regge entrambi i ruoli, vedi sopra — altrimenti restano due dispositivi distinti sulla stessa rete locale)
- 2-3 nodi fissi (Raspberry Pi / mini-PC) per estendere la copertura BLE/Wi-Fi
- 10-50 smartphone come client opportunistici

Contenuti tipici: mappa, sentieri, informazioni rifugio, numeri utili, manuali, bollettini meteo dell'ultimo aggiornamento, documentazione di sicurezza, AI locale.

Sequenza di test target: Internet attivo → sincronizzazione iniziale → Internet spento → accesso ai contenuti dalla mesh → messaggistica → spostamento utenti tra nodi → riavvio di un nodo → perdita permanente di un nodo → ritorno di Internet → risincronizzazione.

## Pilot: emergenza (§104, caso d'uso §6.1)

Scenario: Internet e rete cellulare assenti, alcuni nodi spenti, alcuni nodi mobili (courier), packet loss elevato, rete divisa in segmenti che si ricollegano nel tempo.

Metriche da raccogliere (vedi anche §76-79): tempo di discovery, percentuale di messaggi consegnati, percentuale di contenuti disponibili, tempo di sincronizzazione tra segmenti, consumo batteria, traffico generato, numero medio di hop.

## Non ancora pianificato in dettaglio

Eventi affollati, scuole, spedizioni/navi, comunità locali (§6.4-6.7) sono casi d'uso validi secondo la specifica ma non hanno ancora un piano di pilot dedicato: il rifugio alpino e lo scenario di emergenza sono i due deployment prioritari.

**Benchmark hardware reale, prerequisito per scegliere tra "tutto in uno" e il modello a due livelli sopra**: non ancora eseguito in questo ambiente (nessun accesso a hardware fisico). Servirebbe far girare un modello Ollama minimo (~0.5-1B parametri, quantizzato) su un Orange Pi Zero 2W reale, misurando token/secondo sotto carico concorrente (mentre 2-3 telefoni scaricano contenuti dalla mesh contemporaneamente, non isolato) — è l'unico modo per sapere se l'opzione "tutto in uno" è davvero percorribile o se conviene il modello a due livelli fin da subito.
