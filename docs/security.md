# Sicurezza

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §52-58. Vedi anche [`reuse-vs-new.md`](./reuse-vs-new.md) per cosa è concettualmente ispirato a BitChat e cosa va progettato da zero.

## Stato attuale (Milestone 1-13, 15 quasi completa, 16 parziale)

Implementato:

- **Identità crittografica per nodo** (§14, §53): coppia di chiavi Ed25519 generata con `node:crypto`. Il node id esposto (`node/src/identity.ts`) è l'hex della chiave pubblica; la chiave privata non lascia mai il processo e non viene mai serializzata nei pacchetti.
- **Firma del publisher sui contenuti** (§55): ogni contenuto pubblicato tramite `NomadNode.publishContent()` viene firmato (`node/src/content.ts`, `contentSigningPayload`/`verifyContentSignature`). Il payload firmato copre `contentId, name, mimeType, size, publisherId` — non solo l'hash del contenuto — proprio per impedire che un relay possa "rietichettare" un contenuto genuino (stessi byte, nome/tipo diversi) mantenendo la firma valida.
- **Verifica applicata coerentemente su tutti i percorsi che accettano contenuto dalla rete**: sia il completamento di un trasferimento richiesto da questo nodo, sia la cache passiva di un relay che inoltra chunk altrui, sia una voce di catalogo ricevuta via sync — tutti passano per `ContentStore.putVerified()` / `verifyContentSignature()` prima di fidarsi di qualunque cosa dichiarata da un peer.
- **Content id immutabile per costruzione** (§24, §33): poiché `content_id = sha256(bytes)`, una volta accettata una voce di catalogo valida per un dato id non c'è nulla da "aggiornare" — `RemoteCatalog.record()` tiene la prima voce valida ricevuta.
- **Trust levels** (§54): `UNKNOWN/SEEN/VERIFIED/TRUSTED/ADMIN` per node id (`node/src/trust.ts`). `SEEN` alla connessione diretta; `VERIFIED` quando una firma di quel node id verifica correttamente (evidenza crittografica reale che quel nodo controlla la chiave privata corrispondente — non un giudizio su quanto sia affidabile *il contenuto* firmato). `TRUSTED`/`ADMIN` sono assegnazioni manuali dell'operatore (`trust.set(nodeId, level)`), pensate per reti controllate (RIFUGIO-NET, SOCCORSO-NET, §54). Un nodo può opzionalmente rifiutarsi di fare da relay per un peer sotto una soglia (`minTrustToRelay`), senza che questo influisca sulle richieste dirette di quel peer verso di lui.
- **Rate limiting / admission control** (§57): budget di pacchetti per finestra temporale, per singolo peer (`node/src/rate-limit.ts`) — un peer che genera più traffico del budget vede i pacchetti in eccesso scartati, senza impattare gli altri peer.
- **Relay policy legata a batteria/carica** (§51, §58): un nodo può configurare quando è disposto a fare da relay (`off`/`always`/`when-charging`/`battery-above`, `node/src/relay-policy.ts`) in base al proprio stato di risorse auto-dichiarato — non hardware reale in questo prototipo, ma il meccanismo è pronto per riceverlo.

Testato esplicitamente contro tentativi di manomissione (non solo contro errori accidentali): impersonificazione di un altro publisher, contenuto rietichettato dopo la firma, voci di catalogo forgiate iniettate via socket grezzo, contenuto con hash corretto ma firma falsa sul percorso di recupero principale, gate di fiducia/relay-policy aggirati tramite la coda di store-and-forward. Vedi `tests/unit/content.test.ts`, `tests/integration/content-integrity-security.test.ts`, `tests/integration/catalog-sync-security.test.ts`, `tests/integration/store-and-forward-relay-gate.test.ts`.

**Non implementato**:

- Cifratura end-to-end dei pacchetti tra sender e destinatario finale (§52) — oggi un relay può leggere il payload in chiaro.
- Privacy/minimizzazione degli identificatori (§56).
- Routing a costo multi-metrica completo (§22) — la relay policy decide "faccio da relay in generale, sì/no", non "qual è il percorso migliore tra più alternative".
- **Binding crittografico tra identità e connessione di trasporto**: il campo `source` di un pacchetto (incluso l'`HELLO` iniziale) è dichiarato dal peer, non provato crittograficamente in fase di handshake. Un nodo può dichiarare qualunque node id come mittente — ciò che *non* può fare è produrre una firma valida per contenuto o voci di catalogo che non ha realmente pubblicato, perché la firma è verificata contro la chiave pubblica corrispondente al node id dichiarato.

## Tre bug di sicurezza reali trovati e corretti durante lo sviluppo

Utile registrarli qui perché illustrano bene la differenza tra "il codice compila e i test passano" e "il codice fa davvero quello che promette" — nessuno dei tre era visibile finché non è stato specificamente cercato con un review mirato:

1. **Catalogo remoto senza verifica**: la prima versione del catalog sync (Milestone 13) registrava qualunque voce dichiarata da un peer in una `SYNC_RESPONSE`, senza controllare la firma — un solo nodo malevolo poteva iniettare "questo contenuto esiste, firmato da `<vittima>`" e vederlo propagarsi transitivamente ad ogni sync successivo. Corretto verificando la firma prima di accettare qualunque voce, esattamente come già avveniva per i byte reali.
2. **Firma che copriva solo l'hash**: la prima versione della firma (Milestone 15) firmava solo `content_id`, non nome/tipo/dimensione — un relay poteva rietichettare un contenuto genuinamente firmato (es. da "note.txt" a "aggiornamento-sicurezza.exe") mantenendo la firma valida. Corretto includendo l'intero set di metadata rilevante nel payload firmato.
3. **Il più grave: verifica della firma ignorata sul percorso principale**: in `handleContentComplete` (il codice che gestisce la fine di un trasferimento richiesto da questo nodo), l'esito di `ContentStore.putVerified()` — che include il controllo della firma — veniva calcolato ma **mai controllato**: la richiesta di contenuto (`getContent()`) veniva comunque risolta con i byte ricevuti, indipendentemente dal fatto che la firma fosse valida o meno. Un nodo con hash corretto ma firma falsa/assente avrebbe comunque visto il proprio contenuto accettato come fidato. Corretto controllando esplicitamente il risultato prima di risolvere la richiesta del chiamante.

Un quarto problema, meno grave ma dello stesso spirito, è stato corretto insieme ai livelli di fiducia: i pacchetti rimessi in coda per store-and-forward (Milestone 12) venivano ritentati **senza ripassare** dai controlli di fiducia/relay-policy — un modo silenzioso per aggirare una revoca di fiducia o una policy "non fare da relay" per qualunque cosa fosse già in coda al momento del cambiamento.

## Direzione per l'implementazione futura

Da studiare come riferimento di design (non da importare come codice, vedi §52 e `reuse-vs-new.md`): il modello di identità a chiavi crittografiche e sessioni sicure basate su Noise usato da BitChat (https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md).

Modello zero-trust previsto (§52):

```
Sender -> encrypt -> Relay (opaque packet) -> Relay -> Receiver -> decrypt
```

Un relay instrada senza poter leggere il payload di un `DATA` o `CONTENT_CHUNK` privato. Questo resta da fare: oggi l'autenticità (firma) è garantita, la riservatezza no.
