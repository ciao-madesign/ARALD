# Deployment

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §8-9, §39-40, §85-86, §103-104.

> Nessuno degli scenari descritti in questo documento è ancora eseguibile: richiedono le milestone 6-19 (BLE, mobile, integrazione NOMAD, gateway, store-and-forward — vedi [`roadmap.md`](./roadmap.md)), non ancora implementate. Questo documento descrive il *target* di deployment verso cui il codice attuale (Milestone 0-5, solo TCP su LAN/localhost) è il primo gradino.

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

## Pilot: rifugio alpino (§103, caso d'uso prioritario §6.2)

Per la componentistica minima e le istruzioni passo passo di installazione/gestione di un singolo nodo fisso (comprensibili anche a un operatore senza competenze informatiche o elettroniche, es. il gestore del rifugio) vedi [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md).

Configurazione target:

- 1 NOMAD server (Docker, Debian-based)
- 1 gateway (può coincidere con il NOMAD server)
- 2-3 nodi fissi (Raspberry Pi / mini-PC) per estendere la copertura BLE/Wi-Fi
- 10-50 smartphone come client opportunistici

Contenuti tipici: mappa, sentieri, informazioni rifugio, numeri utili, manuali, bollettini meteo dell'ultimo aggiornamento, documentazione di sicurezza, AI locale.

Sequenza di test target: Internet attivo → sincronizzazione iniziale → Internet spento → accesso ai contenuti dalla mesh → messaggistica → spostamento utenti tra nodi → riavvio di un nodo → perdita permanente di un nodo → ritorno di Internet → risincronizzazione.

## Pilot: emergenza (§104, caso d'uso §6.1)

Scenario: Internet e rete cellulare assenti, alcuni nodi spenti, alcuni nodi mobili (courier), packet loss elevato, rete divisa in segmenti che si ricollegano nel tempo.

Metriche da raccogliere (vedi anche §76-79): tempo di discovery, percentuale di messaggi consegnati, percentuale di contenuti disponibili, tempo di sincronizzazione tra segmenti, consumo batteria, traffico generato, numero medio di hop.

## Non ancora pianificato in dettaglio

Eventi affollati, scuole, spedizioni/navi, comunità locali (§6.4-6.7) sono casi d'uso validi secondo la specifica ma non hanno ancora un piano di pilot dedicato: il rifugio alpino e lo scenario di emergenza sono i due deployment prioritari.
