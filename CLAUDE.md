# Nomad-Net — contesto per Claude Code

Questo file viene letto automaticamente a ogni nuova sessione in questo repository. Obiettivo: far ripartire un nuovo sviluppatore (umano o Claude) senza dover rileggere l'intera cronologia della chat.

## Cos'è questo progetto

Nomad-Net è un prototipo software di rete distribuita, **content-centric** e **delay-tolerant**: dispositivi condividono contenuti, servizi e messaggi senza infrastruttura Internet, tramite mesh locali, store-and-forward, caching opportunistico e sincronizzazione automatica al ritorno della connettività. Ispirato concettualmente a BitChat (mesh BLE) e pensato per integrarsi con Project NOMAD come "service provider" locale (Kiwix, Ollama, ecc.), ma senza dipendere da nessuno dei due.

**Specifica completa e single source of truth**: [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) (in italiano, numerata per paragrafi §N — tutti i riferimenti nel codice e nei commenti usano questa numerazione). Se qualcosa nel codice sembra contraddire questo file, la specifica vince; se manca un dettaglio, cercalo lì prima di indovinare.

**Repository GitHub**: `ciao-madesign/nomad-net`. **Branch di lavoro**: `claude/nomad-net-project-spec-lcnbqt`.

## Regola permanente: push su main

**Istruzione permanente data dall'utente in questa sessione: ogni commit va pushato sia sul branch di lavoro sia direttamente su `main`.** Non è implicita nel workflow standard di Claude Code (che normalmente lavora solo sul branch dedicato) — è stata data esplicitamente e va rispettata per ogni futuro commit, non solo per quelli già fatti. Verifica sempre che `main` sia allo stesso commit del branch di lavoro prima di pushare (fast-forward), altrimenti chiedi come procedere invece di forzare.

## Stato del progetto

Milestone 0-7, 12, 13, 15, 16, 20 della roadmap sono complete (identità crittografica, protocollo a pacchetti, transport TCP, routing multi-hop con controlled flooding + distance-vector a costo, content discovery/cache, store-and-forward, partition sync, firma dei contenuti, trust levels, rate limiting, E2E encryption, relay policy legata a batteria, simulatore di rete). Dettaglio completo in [`docs/roadmap.md`](docs/roadmap.md).

Dopo il completamento delle milestone sopra è stato eseguito un **audit tecnico completo** (test, sicurezza, qualità del codice — vedi [`docs/audit-report.html`](docs/audit-report.html), un Artifact pubblicato e aggiornabile) che ha identificato ulteriori miglioramenti realizzabili in puro software. Questi sono in corso come una sequenza di **9 slice**, ciascuna con lo stesso workflow a "doppio check" (vedi sotto), tracciate in `docs/security.md` sotto "Bug corretti nel seguito dell'audit":

| # | Slice | Stato |
|---|---|---|
| 1 | Retry al prossimo content provider quando quello attivo tace | ✅ Fatto |
| 2 | `BoundedFifoMap` condivisa (rimossa duplicazione 5x) | ✅ Fatto |
| 3 | Eviction pesata sulla fiducia per `PeerDirectory`/`RemoteCatalog` | ✅ Fatto |
| 4 | Scheduling reale basato su priorità in `TcpTransport` | ✅ Fatto |
| 5 | Pacchetto `CONTENT_NOT_FOUND` + scadenza dei contenuti | ✅ Fatto |
| 6 | Protocollo di service discovery (`SERVICE_*`) | ✅ Fatto |
| 7 | Interfaccia web locale di stato/ricerca (spec §59) | ✅ Fatto |
| 8 | Transport BLE simulato | ⏳ Prossimo |
| 9 | Gateway NOMAD mockato (contro un fake server locale) | ⏳ Da fare |

Ogni slice completata è documentata in dettaglio in `docs/security.md` (numerate progressivamente, es. bug #11-17) e spesso anche in `docs/protocol.md`. **Leggi quelle voci prima di toccare il codice corrispondente** — spiegano non solo cosa è stato fatto ma perché, inclusi i bug trovati dalla revisione e corretti prima di considerare ogni slice conclusa.

`docs/roadmap.md` e `README.md` contengono ancora, in alcuni punti, la dicitura "non restano candidati aperti in puro software" ereditata da prima che questo arco di 9 slice iniziasse — è imprecisa per lo stato attuale (Slice 8 dimostra che un transport BLE *simulato* è comunque puro software) e viene aggiornata progressivamente.

## Come continuare il lavoro sulle slice rimanenti

Il workflow concordato con l'utente per ogni slice, da ripetere identico:

1. Implementa la feature.
2. Scrivi/aggiorna i test (unit + integration, seguendo le convenzioni esistenti — vedi sotto).
3. Fai girare l'intera suite più volte di fila (`npx vitest run`, ripetuto 3-15x a seconda della sensibilità a timing/race) per scovare flakiness prima che la trovi la revisione.
4. Invoca la skill `code-review` con un prompt dettagliato che spiega cosa è cambiato e dove concentrare l'attenzione — non un generico "rivedi questo diff".
5. Correggi i problemi reali trovati (non solo quelli comodi), aggiungi test di regressione dedicati per ciascuno, ri-verifica.
6. Aggiorna `docs/security.md` (nuova voce numerata) e `docs/protocol.md`/altri doc pertinenti.
7. `npx tsc --noEmit -p node/tsconfig.json` e `npm run build -w node` puliti.
8. Commit con messaggio dettagliato (cosa, perché, cosa ha trovato la revisione), push su **sia** `claude/nomad-net-project-spec-lcnbqt` **sia** `main`.
9. Report all'utente in italiano, **poi fermati e aspetta un "ok" esplicito prima di iniziare la slice successiva** — istruzione esplicita data dall'utente all'inizio di questo arco di lavoro ("Dopo ogni step aggiornami e chiedimi ok per proseguire"), tuttora in vigore.

Non saltare il passaggio di code-review nemmeno quando il codice "sembra ovviamente corretto": in ogni slice fatta finora ha trovato almeno un problema reale (spesso più di uno) prima di considerare la slice conclusa — inclusi almeno due crash-DoS reali (accesso non protetto a un campo di payload potenzialmente assente) e diverse race condition/edge case di conteggio.

## Struttura del repository

```
nomad-net/
├─ docs/            specifica (SPECIFICATION.md) e documentazione tecnica
├─ node/src/        nomad-node: il runtime di rete (unico package con codice reale)
├─ tests/           unit/, integration/, network/ (vitest)
├─ tools/simulator/ simulatore di rete a scala (usato anche da `npm run simulate`)
├─ gateway/         segnaposto per il gateway NOMAD/Internet — non ancora implementato (Slice 9 lo mocka)
├─ mobile/          segnaposto app Android/iOS — non ancora implementato
└─ protocol/        segnaposto definizioni di protocollo condivise — non contiene codice reale
```

Tutto il codice reale vive sotto `node/src/`. `gateway/`, `mobile/`, `protocol/` sono placeholder dalla specifica, non toccarli aspettandosi codice.

### File chiave in `node/src/` e a cosa servono

- `identity.ts` — identità Ed25519 per nodo (`Identity`), firma/verifica.
- `packet.ts` — `MessageType` enum, formato pacchetto, `Priority` enum (spec §50), encode/decode newline-JSON.
- `transport.ts` — interfaccia `Transport` astratta; `transports/tcp.ts` è l'unica implementazione reale finora (Slice 8 ne aggiunge una simulata per BLE).
- `routing.ts` — `SeenCache` (dedup) + `decideForward()`, il cuore del controlled flooding (spec §21).
- `routing-table.ts` — routing a costo distance-vector (spec §22), alternativa/complemento al flooding per traffico unicast.
- `content.ts` — `ContentStore`, firma/verifica dei contenuti, `ChunkAssembler`, scadenza (`expiresAt`).
- `catalog.ts` — `RemoteCatalog`, contenuto noto ma non ancora scaricato (sync tra segmenti di rete).
- `service.ts` / `service-directory.ts` — service discovery (spec §35-37), stesso schema di firma di `content.ts`.
- `store-and-forward.ts` — coda per pacchetti unicast non consegnabili subito.
- `trust.ts` — `TrustLevel`/`TrustManager` (spec §54).
- `rate-limit.ts` — budget di pacchetti per peer per finestra temporale.
- `relay-policy.ts` — quando un nodo fa da relay in base a batteria/carica auto-dichiarata.
- `encryption.ts` — E2E per messaggi privati (X25519 + AES-256-GCM), `IdentityAnnouncement`.
- `peer-directory.ts` — propagazione delle chiavi di cifratura tra peer.
- `bounded-map.ts` — `BoundedFifoMap<K,V>`, struttura dati limitata condivisa (con eviction opzionale pesata su uno score, es. la fiducia) usata da quasi tutte le strutture sopra che vengono alimentate dalla rete.
- `priority-queue.ts` — coda a bucket per priorità (6 livelli), usata da `transports/tcp.ts` per lo scheduling reale degli invii.
- `web-ui.ts` — interfaccia web locale di stato/ricerca (spec §59), server `node:http` minimale.
- `node.ts` — `NomadNode`, la classe che orchestra tutto il resto; qui vivono i pacchetti-handler (`handleContentQuery`, `handleServiceRequest`, ecc.) e i metodi pubblici (`getContent`, `callService`, `publishContent`, ...).
- `cli.ts` — entry point eseguibile (`npm run dev -w node --`).

## Convenzioni consolidate (da rispettare per coerenza, non da riscoprire)

- **Ogni struttura dati alimentata dalla rete è limitata per dimensione** (spec §57): usa `BoundedFifoMap` con `maxSize`, e quando la fiducia dell'origine è nota passa `evictionScore`/`trustRank` così l'eviction preferisce rimuovere la voce meno fidata invece della più vecchia — altrimenti un peer può fabbricare identità usa-e-getta per sfrattare voci legittime (vedi bug #13 in `security.md`). Strutture puramente locali (mai alimentate da pacchetti di rete, es. `localServices` in `node.ts`) non hanno bisogno di questo limite.
- **Ogni claim che arriva dalla rete e verrà ri-propagato ad altri peer viene firmato dal suo autore** (Ed25519, stesso pattern in `content.ts`/`encryption.ts`/`service.ts`): un campo `SignableXFields`, una funzione `xSigningPayload()` con ordine esplicito dei campi, una `verifyX()` che riverifica contro la chiave pubblica dichiarata. Un relay non fidato può inoltrare ma mai fabbricare un claim valido per un'identità che non controlla.
- **Il payload di un pacchetto non è mai fidato quanto il suo tipo dichiarato**: `decodePacket()` valida solo l'involucro (id/type/source/ttl), mai la forma del payload — ogni handler deve accedere ai campi del payload in modo difensivo (`packet.payload?.campo`, controlli `typeof`/`Array.isArray`), perché un singolo pacchetto malformato da un peer connesso non deve mai poter far crashare il processo. Questo ha causato almeno un vero DoS non autenticato scoperto dalla revisione (Slice 6, bug #16) — vedi `tests/integration/malformed-packet-robustness.test.ts` per il pattern di test dedicato, da estendere per ogni nuovo tipo di pacchetto.
- **Scadenza "pigra", mai un timer di sweep in background**: `ContentStore`/`RemoteCatalog`/`ServiceDirectory` trattano una voce scaduta come assente ed eliminano al momento dell'accesso (`get`/`has`/`list`/`size`), non con un `setInterval`.
- **`packet.source` non è mai autenticato crittograficamente** (limite noto e documentato in `security.md` sotto "Binding crittografico") — chiunque può dichiararsi qualunque node id nel campo `source`. Ciò che *non* può fare è produrre una firma valida per un'identità che non controlla. Ogni nuovo meccanismo che si affida a `packet.source` per decidere qualcosa di sensibile (es. quale risposta accettare per una richiesta pendente) deve comunque vincolarsi al mittente atteso (es. `packet.source === entry.activeProvider`), non fidarsi ciecamente — pattern già usato in `handleContentChunk`/`handleContentComplete`/`handleServiceResponse`.
- **Nessuna nuova dipendenza esterna senza necessità reale**: `web-ui.ts` usa `node:http` puro invece di aggiungere Express; `tcp.ts` non usa framework di parsing. Il solo devDependency oltre a TypeScript/vitest/tsx è quanto già presente.
- **Test**: unit in `tests/unit/` (logica pura, nessuna rete reale), integration in `tests/integration/` (istanze reali di `NomadNode`/`TcpTransport` su localhost, a volte con socket grezzi via `node:net` per controllo deterministico del timing quando serve simulare un comportamento avversariale/di rete inaffidabile — vedi `content-provider-retry.test.ts` per il pattern). Non usare mock per `NomadNode` stesso: la suite esistente preferisce nodi reali connessi via TCP reale su porta `0` (assegnata dal SO), anche nei test più intricati.
- **Race di timing nota e ricorrente nei test**: `connect()` che si risolve garantisce solo che il lato che ha iniziato la connessione abbia identificato il peer, non che l'altro lato abbia già processato l'HELLO in arrivo. Se un test fa qualcosa sul lato "server" subito dopo che `connect()` si risolve sul lato "client" (es. registrare un servizio e aspettarsi che venga floodato al peer appena connesso), potrebbe fallire in modo intermittente — aggiungere un `waitFor()` esplicito sullo stato effettivamente osservabile (es. `provider.node.peers.has(caller.node.nodeId)`) prima di procedere.

## Comandi utili

```bash
npm install                                    # alla radice, installa anche il workspace node/
npx vitest run                                 # intera suite di test
npx vitest run tests/integration/xyz.test.ts   # un file specifico
npx tsc --noEmit -p node/tsconfig.json         # typecheck senza emettere output
npm run build -w node                          # build del package node/
npm run dev -w node -- --id A --port 9001      # avvia un nodo (aggiungi --web-port 8080 per l'UI web)
npm run simulate -- --nodes 50 --topology random  # simulatore di rete a scala
```

## Cosa NON fare

- Non commitare/pushare senza che i test passino ripetutamente, il typecheck e la build siano puliti.
- Non saltare la fase di code-review su una slice "perché sembra semplice".
- Non procedere alla slice successiva senza l'ok esplicito dell'utente, anche se la precedente sembra ovviamente completa.
- Non introdurre dipendenze esterne per problemi risolvibili con la libreria standard di Node.
- Non fidarsi di `packet.source` o della forma del `payload` di un pacchetto in arrivo senza validazione difensiva.
