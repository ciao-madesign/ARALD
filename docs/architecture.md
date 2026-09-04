# Architettura

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §1-10, §37-40, §75, §98-99.

## Livelli

```
APPLICATION LAYER        Web / Chat / Files / Maps / Search / AI
SERVICE / CONTENT LAYER  NOMAD / Kiwix / Kolibri / Maps / AI / Apps
OFFLINE NETWORK FABRIC   Discovery / Routing / Cache / Sync / Replication / Store & Forward
TRANSPORT LAYER          BLE / Wi-Fi Direct / Wi-Fi LAN / Ethernet / Internet
```

Il Network Fabric (questo repository) non dipende da un transport specifico: ogni transport implementa la stessa interfaccia (`node/src/transport.ts`) ed è intercambiabile.

## Tre ruoli distinti (§99)

| Livello | Domanda a cui risponde | Repository |
|---|---|---|
| ARALD | "Come raggiungo una risorsa?" | questo repository |
| Project NOMAD | "Quali risorse e servizi posso offrire?" | https://github.com/Crosstalk-Solutions/project-nomad (esterno, non forkato) |
| Gateway | "Come collego ARALD a una rete esterna?" | `gateway/` in questo repository |

## Nodo logico (§7)

```
Mesh Node
+-- Identity Manager     node/src/identity.ts (firma, Ed25519), node/src/encryption.ts (cifratura, X25519)
+-- Transport Manager    node/src/transport.ts, node/src/transports/*
+-- Peer Discovery       node/src/peer.ts
+-- Routing Engine       node/src/routing.ts (controlled flooding, bootstrap/fallback e broadcast) + node/src/routing-table.ts (distance-vector a costo, unicast)
+-- Content Discovery    node/src/content.ts
+-- Cache Manager        node/src/content.ts (ContentStore)
+-- Store & Forward      node/src/store-and-forward.ts — implementato (pacchetti unicast, vedi roadmap.md milestone 12)
+-- Sync Engine          node/src/catalog.ts (contenuti) + node/src/peer-directory.ts (identità/chiavi) — implementato (vedi roadmap.md milestone 13, 15)
+-- Security Manager     node/src/trust.ts, node/src/rate-limit.ts, node/src/content.ts, node/src/encryption.ts — completo, vedi security.md
+-- Service Registry     node/src/service.ts, node/src/service-directory.ts — implementato (seguito audit, voce #6, spec §35-37)
+-- Storage Manager      node/src/content.ts (in-memory nel prototipo)
+-- Resource Manager     node/src/relay-policy.ts — implementato (relay on/off/when-charging/battery-above, vedi milestone 16)
```

Non tutti i nodi implementano tutte le funzioni: uno smartphone può essere client/cache/relay limitato, un computer relay/server/cache/gateway, un server NOMAD service/content provider (§7).

## Stato di implementazione attuale (Milestone 0-7, 12, 13, 15, 16, 20)

Lo stato corrente del codice copre le Milestone 1-7 della specifica (§62-66: identità, packet protocol, transport TCP, routing multi-hop con TTL e deduplicazione, content discovery, cache), la Milestone 12 (store-and-forward), la Milestone 13 (sincronizzazione dei cataloghi), la Milestone 15 (firma dei contenuti, trust levels, rate limiting, cifratura E2E dei messaggi privati), la Milestone 16 (relay policy legata a batteria/carica **e** routing a costo distance-vector, §22) e la Milestone 20 (simulatore di rete a scala). Un secondo giro post-audit (9 voci pianificate più una decima aggiunta su richiesta dell'utente, dettaglio in [`security.md`](./security.md)) ha poi aggiunto: retry sui content provider, `CONTENT_NOT_FOUND`+scadenza dei contenuti, service discovery, interfaccia web locale, e le **versioni simulate/mockate** di BLE (`node/src/transports/ble.ts`) e di tre sotto-servizi del gateway NOMAD (`gateway/nomad/`: `KiwixGateway` per gli archivi consultabili, `AiGateway` per `service://ai`, `NewsGateway` per `service://news`) — tutte e quattro validano la logica applicativa dietro le stesse interfacce (`Transport`, l'adapter HTTP verso NOMAD) senza hardware BLE reale né Docker/Project NOMAD reale. Diversi follow-up successivi (voci #21-49, `docs/security.md`) hanno poi aggiunto un'app mobile Capacitor (`mobile/`) verso il gateway, con pairing in stile Wi-Fi anche via QR e una dashboard in stile "motore di ricerca"; una passata di rebrand completa ("Waypoint", voci #28-31) e una passata UX dedicata per un pubblico generico e non tecnico (voce #48) hanno poi sottoposto quella UI a una vera passata di design — resta annotato solo un possibile restyling grafico futuro per un aspetto più moderno, non ancora pianificato in dettaglio. Restano bloccati sui rispettivi prerequisiti esterni solo le **forme realistiche finali**: hardware BLE fisico, Wi-Fi Direct reale, la build Android nativa, un'istanza reale di Project NOMAD via Docker, e fonti di notizie reali via internet (vedi [`roadmap.md`](./roadmap.md) per il dettaglio di cosa è bloccato da cosa), costruiti bottom-up (§89, §105) senza saltare livelli quando si potrà riprendere.

## Gateway (§8, §37-40)

Un gateway non è un hardware specifico: è qualunque nodo che ha accesso sia a ARALD sia a un'altra rete (tipicamente Internet, o l'API locale di Project NOMAD). Nel primo prototipo il gateway è semplicemente il computer di sviluppo; in produzione può essere un mini-PC o un Raspberry Pi sempre acceso. Non è previsto che il primo modello di deployment usi uno smartphone come gateway infrastrutturale (§39).
