# Roadmap

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §61-74, §88, §90-95, §102.

Stato al 10 agosto 2026, versione specifica 0.1.

## Milestone

| # | Milestone | Stato | Note |
|---|---|---|---|
| 0 | Repository e documentazione | ✅ Fatto | questo commit |
| 1 | Node runtime (identity, packet, TCP, HELLO/PING/PONG, peer list) | ✅ Fatto | `node/src/identity.ts`, `packet.ts`, `transports/tcp.ts` |
| 2 | Packet protocol (TTL, dedup, multi-hop `A -> B -> C`) | ✅ Fatto | `node/src/routing.ts` |
| 3 | TCP transport | ✅ Fatto | incluso in Milestone 1 |
| 4 | Multi-hop | ✅ Fatto | `tests/integration/three-node-relay.test.ts` |
| 5 | Content discovery | ✅ Fatto | `node/src/content.ts`, `tests/integration/content-retrieval.test.ts` |
| 6 | File transfer (chunking, verifica hash) | ✅ Fatto | incluso nel content protocol, chunking a scopo dimostrativo |
| 7 | Cache | ✅ Fatto | `tests/integration/cache-replication.test.ts` |
| 8 | BLE | ⏳ Non iniziato | richiede `node/src/transports/ble.ts` dietro l'interfaccia `Transport` esistente |
| 9 | Smartphone (app mobile minimale) | ⏳ Non iniziato | `mobile/android` prioritario su `mobile/ios` (§47) |
| 10 | NOMAD integration | ⏳ Non iniziato | richiede Project NOMAD in esecuzione (Docker, Debian-based) |
| 11 | Gateway (`gateway/nomad/`) | ⏳ Non iniziato | traduzione richieste Nomad-Net → API NOMAD |
| 12 | Store-and-forward | ⏳ Non iniziato | coda di consegne pendenti per destinatario irraggiungibile |
| 13 | Partition synchronization | ⏳ Non iniziato | confronto cataloghi tra segmenti di rete riconnessi |
| 14 | Wi-Fi high bandwidth | ⏳ Non iniziato | `node/src/transports/wifi.ts` |
| 15 | Security hardening | ⏳ Non iniziato | firma dei contenuti, trust levels, E2E, rate limiting — vedi `security.md` |
| 16 | Energy-aware routing | ⏳ Non iniziato | funzione di costo multi-metrica (§22) |
| 17 | Raspberry / mini-PC node | ⏳ Non iniziato | deployment hardware, non richiesto per MVP software |
| 18 | Rifugio pilot | ⏳ Non iniziato | vedi `deployment.md` |
| 19 | Emergency pilot | ⏳ Non iniziato | vedi `deployment.md` |
| 20 | Scalability testing | ⏳ Non iniziato | 100+ dispositivi simulati (§80) |

## I "cinque obiettivi tecnici" della specifica (§90-95)

1. ✅ **Primo obiettivo**: `A -> B -> C` senza Internet, A recupera `content://example/hello` posseduto solo da C.
2. ✅ **Secondo obiettivo**: un quarto nodo D recupera lo stesso contenuto da A (cache), senza raggiungere C.
3. ✅ **Terzo obiettivo**: C viene spento, B (che ha il contenuto in cache) risponde a D.
4. ⏳ **Quarto obiettivo**: due mesh separate si incontrano e sincronizzano i cataloghi (richiede Milestone 13).
5. ⏳ **Quinto obiettivo**: un gateway con Internet recupera un contenuto assente localmente e lo propaga nella mesh (richiede Milestone 11-12).

Gli obiettivi 1-3 sono dimostrati dai test in `tests/integration/`. L'obiettivo finale (§95 — la rete continua a funzionare transitando tra `ONLINE -> OFFLINE -> PARTITIONED -> SYNCING -> ONLINE`) richiede il completamento di tutte le milestone precedenti.

## Ordine di lavoro consigliato per i prossimi passi

Seguendo il principio bottom-up (§89), le milestone candidate come prossimo passo dopo lo stato attuale sono la Milestone 8 (BLE transport), la Milestone 10-11 (NOMAD + gateway) e la Milestone 12 (store-and-forward) — nessuna dipende dalle altre, quindi l'ordine è una scelta di prodotto, non un vincolo tecnico. Il confronto dettagliato (file coinvolti, prerequisiti, rischi, criteri di accettazione per ciascuna) è in [`docs/next-steps.md`](./next-steps.md). Non è raccomandato iniziare la Milestone 15 (sicurezza) prima di aver validato almeno un transport reale oltre a TCP, per evitare di dover ridisegnare il modello di trust attorno a un solo transport.
