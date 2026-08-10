# Sicurezza

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §52-58. Vedi anche [`reuse-vs-new.md`](./reuse-vs-new.md) per cosa è concettualmente ispirato a BitChat e cosa va progettato da zero.

## Stato attuale (Milestone 1-13, 15 parziale)

Implementato:

- **Identità crittografica per nodo** (§14, §53): coppia di chiavi Ed25519 generata con `node:crypto`. Il node id esposto (`node/src/identity.ts`) è l'hex della chiave pubblica; la chiave privata non lascia mai il processo e non viene mai serializzata nei pacchetti.
- **Firma del publisher sui contenuti** (§55): ogni contenuto pubblicato tramite `NomadNode.publishContent()` viene firmato (`node/src/content.ts`, `contentSigningPayload`/`verifyContentSignature`). Il payload firmato copre `contentId, name, mimeType, size, publisherId` — **non solo l'hash del contenuto** — proprio per impedire che un relay possa "rietichettare" un contenuto genuino (stessi byte, nome/tipo diversi) mantenendo la firma valida.
- **Verifica applicata coerentemente su tutti i percorsi che accettano contenuto dalla rete**: sia il completamento di un trasferimento richiesto da questo nodo (`handleContentComplete`), sia la cache passiva di un relay che inoltra chunk altrui (`observeRelayedContent`), sia una voce di catalogo ricevuta via sync (`handleSyncResponse`) — tutti passano per `ContentStore.putVerified()` / `verifyContentSignature()` prima di fidarsi di qualunque cosa dichiarata da un peer. Un contenuto il cui hash torna ma la cui firma non verifica viene rifiutato: `getContent()` termina con un errore invece di restituire byte non verificati.
- **Content id immutabile per costruzione** (§24, §33): poiché `content_id = sha256(bytes)`, una volta accettata una voce di catalogo valida per un dato id non c'è nulla da "aggiornare" — `RemoteCatalog.record()` tiene la prima voce valida ricevuta, senza basarsi su un campo come `createdAt` che non è coperto dalla firma (e quindi sarebbe manipolabile da un relay senza rompere la verifica).

Testato esplicitamente contro tentativi di manomissione (non solo contro errori accidentali): impersonificazione di un altro publisher, contenuto rietichettato dopo la firma, voci di catalogo forgiate iniettate via socket grezzo — vedi `tests/unit/content.test.ts`, `tests/integration/content-integrity-security.test.ts`, `tests/integration/catalog-sync-security.test.ts`.

**Non implementato** (esplicitamente fuori scope finora, in roadmap):

- Cifratura end-to-end dei pacchetti tra sender e destinatario finale (§52) — oggi un relay può leggere il payload in chiaro.
- Trust levels (`UNKNOWN/SEEN/VERIFIED/TRUSTED/ADMIN`, §54) — oggi un nodo verifica ogni singolo contenuto/voce di catalogo indipendentemente, ma non tiene uno stato di fiducia aggregato per peer.
- Privacy/minimizzazione degli identificatori (§56).
- Rate limiting, admission control, reputation (§57) — nessun limite oggi su quante richieste/pacchetti un peer può generare.
- Relay policy legata a batteria/carica (§58) — nel prototipo desktop non applicabile, rilevante per il porting mobile.
- **Binding crittografico tra identità e connessione di trasporto**: oggi il campo `source` di un pacchetto (incluso l'`HELLO` iniziale) è semplicemente dichiarato dal peer, non provato crittograficamente in fase di handshake. Un nodo malevolo può dichiarare qualunque node id come mittente di un pacchetto — ciò che *non* può fare è produrre una firma valida per contenuto o voci di catalogo che non ha realmente pubblicato, perché la firma (Ed25519) è verificata contro la chiave pubblica corrispondente al node id dichiarato. In altre parole: dichiarare un'identità falsa è possibile, ma non porta a nulla per contenuto/catalogo perché serve comunque la chiave privata corrispondente per produrre una firma che superi la verifica.

## Perché non è ancora tutto implementato

Per principio di sviluppo (§89, §105) la sicurezza viene aggiunta a strati, non tutta insieme. Questa sessione ha completato la parte relativa all'**autenticità del contenuto e dei cataloghi** (la parte più urgente, perché è ciò che content discovery, cache e catalog sync si scambiano costantemente). Cifratura E2E, trust levels e rate limiting restano per una sessione successiva — nessuno dei tre richiede hardware o Docker, sono scelte di scope, non blocchi tecnici.

## Direzione per l'implementazione futura

Da studiare come riferimento di design (non da importare come codice, vedi §52 e `reuse-vs-new.md`): il modello di identità a chiavi crittografiche e sessioni sicure basate su Noise usato da BitChat (https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md).

Modello zero-trust previsto (§52):

```
Sender -> encrypt -> Relay (opaque packet) -> Relay -> Receiver -> decrypt
```

Un relay instrada senza poter leggere il payload di un `DATA` o `CONTENT_CHUNK` privato. Questo resta da fare: oggi l'autenticità (firma) è garantita, la riservatezza no.
