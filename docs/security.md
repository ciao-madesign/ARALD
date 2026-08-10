# Sicurezza

Riferimento completo: [`SPECIFICATION.md`](./SPECIFICATION.md) §52-58. Vedi anche [`reuse-vs-new.md`](./reuse-vs-new.md) per cosa è concettualmente ispirato a BitChat e cosa va progettato da zero.

## Stato attuale (prototipo, Milestone 1-5)

Implementato:

- **Identità crittografica per nodo** (§14, §53): coppia di chiavi Ed25519 generata con `node:crypto`. Il node id esposto (`node/src/identity.ts`) è l'hex della chiave pubblica; la chiave privata non lascia mai il processo e non viene mai serializzata nei pacchetti.
- **Integrità del contenuto** (§55, parziale): il `content_id` è `sha256(payload)`; il ricevente ricalcola l'hash sui chunk riassemblati e rifiuta il contenuto se non corrisponde. Questo previene la corruzione accidentale, **non** ancora un publisher malevolo che ripubblica sotto lo stesso nome (manca la firma, vedi sotto).

**Non implementato** (esplicitamente fuori scope per il prototipo attuale, in roadmap):

- Cifratura end-to-end dei pacchetti tra sender e destinatario finale (§52) — oggi un relay può leggere il payload in chiaro.
- Firma del publisher sui metadata di contenuto (§55) — un nodo intermedio potrebbe in teoria rispondere a una `CONTENT_QUERY` con contenuto proprio ma non verificato.
- Trust levels (`UNKNOWN/SEEN/VERIFIED/TRUSTED/ADMIN`, §54).
- Privacy/minimizzazione degli identificatori (§56).
- Rate limiting, admission control, reputation (§57).
- Relay policy legata a batteria/carica (§58) — nel prototipo desktop non applicabile, rilevante per il porting mobile.

## Perché non è ancora implementato

Per principio di sviluppo (§89, §105) la sicurezza viene aggiunta come livello esplicito (milestone 15, "security hardening") **dopo** che routing, content discovery e cache sono stati validati funzionalmente. Introdurla prematuramente renderebbe più difficile isolare bug di routing da bug crittografici. Questo non è un compromesso di prodotto: il prototipo attuale è pensato per test locali fidati, non per deployment con nodi non fidati.

## Direzione per l'implementazione futura

Da studiare come riferimento di design (non da importare come codice, vedi §52 e `reuse-vs-new.md`): il modello di identità a chiavi crittografiche e sessioni sicure basate su Noise usato da BitChat (https://github.com/permissionlesstech/bitchat/blob/main/WHITEPAPER.md).

Modello zero-trust previsto (§52):

```
Sender -> encrypt -> Relay (opaque packet) -> Relay -> Receiver -> decrypt
```

Un relay instrada senza poter leggere il payload di un `DATA` o `CONTENT_CHUNK` privato.
