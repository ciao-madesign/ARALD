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
| Nomad-Net | "Come raggiungo una risorsa?" | questo repository |
| Project NOMAD | "Quali risorse e servizi posso offrire?" | https://github.com/Crosstalk-Solutions/project-nomad (esterno, non forkato) |
| Gateway | "Come collego Nomad-Net a una rete esterna?" | `gateway/` in questo repository |

## Nodo logico (§7)

```
Mesh Node
+-- Identity Manager     node/src/identity.ts
+-- Transport Manager    node/src/transport.ts, node/src/transports/*
+-- Peer Discovery       node/src/peer.ts
+-- Routing Engine       node/src/routing.ts
+-- Content Discovery    node/src/content.ts
+-- Cache Manager        node/src/content.ts (ContentStore)
+-- Store & Forward      node/src/store-and-forward.ts — implementato (pacchetti unicast, vedi roadmap.md milestone 12)
+-- Sync Engine          node/src/catalog.ts — implementato (vedi roadmap.md milestone 13)
+-- Security Manager     node/src/trust.ts, node/src/rate-limit.ts, node/src/content.ts — quasi completo (manca solo E2E, vedi security.md)
+-- Service Registry     roadmap — non implementato
+-- Storage Manager      node/src/content.ts (in-memory nel prototipo)
+-- Resource Manager     node/src/relay-policy.ts — implementato (relay on/off/when-charging/battery-above, vedi milestone 16)
```

Non tutti i nodi implementano tutte le funzioni: uno smartphone può essere client/cache/relay limitato, un computer relay/server/cache/gateway, un server NOMAD service/content provider (§7).

## Stato di implementazione attuale (Milestone 0-7, 12, 13, 15, 16 parziale, 20)

Lo stato corrente del codice copre le fasi 1-7 della specifica (§62-66: identità, packet protocol, transport TCP, routing multi-hop con TTL e deduplicazione, content discovery, cache), la Milestone 12 (store-and-forward), la Milestone 13 (sincronizzazione dei cataloghi), quasi tutta la Milestone 15 (firma dei contenuti, trust levels, rate limiting — manca solo la cifratura E2E), una parte della Milestone 16 (relay policy legata a batteria/carica) e la Milestone 20 (simulatore di rete a scala). Questo è **tutto ciò che si può costruire e testare senza hardware BLE e senza Docker/Project NOMAD**: BLE, Wi-Fi reale, mobile e gateway NOMAD restano bloccati su quei prerequisiti (vedi [`roadmap.md`](./roadmap.md) per il dettaglio di cosa è bloccato da cosa), costruiti bottom-up (§89, §105) senza saltare livelli quando si potrà riprendere.

## Gateway (§8, §37-40)

Un gateway non è un hardware specifico: è qualunque nodo che ha accesso sia a Nomad-Net sia a un'altra rete (tipicamente Internet, o l'API locale di Project NOMAD). Nel primo prototipo il gateway è semplicemente il computer di sviluppo; in produzione può essere un mini-PC o un Raspberry Pi sempre acceso. Non è previsto che il primo modello di deployment usi uno smartphone come gateway infrastrutturale (§39).
