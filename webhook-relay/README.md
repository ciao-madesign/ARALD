# Webhook relay — un "consegna esterna differita" generico

Un servizio piccolo e indipendente — **fuori dalla mesh ARALD**, come
`whatsapp-relay/` ed `email-relay/` — che un operatore esegue sul proprio
server sempre connesso. È il lato "destinazione" del meccanismo di
[consegna esterna differita](../docs/service-catalog.md#consegna-esterna-differita-file-store-and-forward-verso-lesterno)
(`node/src/external-delivery.ts`): un ARALD Box invia un blob sigillato
end-to-end a questo server quando torna online; questo server lo decifra
(solo lui ha la chiave privata giusta) e lo inoltra come richiesta HTTP a un
webhook configurato dall'operatore.

## Perché generico

`whatsapp-relay/` ed `email-relay/` coprono ciascuno un servizio esterno
reale specifico. I tre esempi rimasti tra i sei discussi in origine — un
post su un canale/bot (Slack/Telegram), un check-in di posizione verso un
servizio di coordinamento, l'upload di un report/foto — condividono la stessa
meccanica di fondo: un invio HTTP verso un indirizzo configurato
dall'operatore. Invece di tre relay quasi identici, questo è **un solo relay
generico**: ogni destinazione porta con sé il proprio `webhookUrl` e un
token di autenticazione fisso opzionale, e questo relay non ha bisogno di
sapere a quale dei tre casi (o a un quarto non ancora pensato) corrisponde
davvero — quello lo decide solo la configurazione dell'operatore.

**Nessuna modifica al protocollo mesh è stata necessaria per questo.** Il
Box trasporta solo byte opachi — "webhook" è solo una scelta di cosa gira
sul lato ricevente, esattamente come per WhatsApp/email.

## Corpo della richiesta verso il webhook

Il lato mesh (`mobile/www/app.js`, pannello "Invia a un'organizzazione") non
invia mai metadati — solo byte grezzi, sia per un messaggio scritto sia per
un file allegato (nessun nome file, nessun MIME type). Questo relay usa
quindi l'unico segnale disponibile per distinguere i due casi: se i byte
decifrati sono un testo UTF-8 valido, il corpo JSON verso il webhook è
`{"text": "..."}`; altrimenti è `{"dataBase64": "..."}` (il file grezzo in
base64) — mai entrambi insieme. Nessun parser multipart/form-data scritto a
mano (`CLAUDE.md`, "niente di nuovo senza necessità reale").

**Limite noto**: un file binario molto piccolo che capita per caso a essere
una sequenza di byte UTF-8 valida verrebbe trattato come testo invece che
come file — conseguenza accettata dell'assenza di metadati sul lato mesh, non
un bug di questo relay.

## Setup

1. Crea un file di configurazione, es. `relay.json`:

   ```json
   {
     "port": 8093,
     "destinations": [
       {
         "destinationId": "coordinamento-cnsas",
         "label": "Canale coordinamento CNSAS",
         "webhookUrl": "https://hooks.slack.com/services/<workspace>/<canale>/<token>",
         "authToken": "<token fisso, se il servizio lo richiede>",
         "keyFile": "./cnsas.key.json"
       }
     ]
   }
   ```

   `webhookUrl` e `authToken` sono per-destinazione — ogni voce può puntare a
   un servizio esterno completamente diverso (un webhook Slack non ha
   bisogno di `authToken`, incorpora già il token nell'URL; una API generica
   può invece richiederlo come header `Authorization: Bearer <authToken>`).
   `keyFile` è dove questo relay persiste la propria coppia di chiavi X25519
   per quella destinazione — generata automaticamente al primo avvio,
   **fanne backup come qualunque altra chiave privata**.

2. Esegui:

   ```bash
   npm run webhook-relay -- --config relay.json
   ```

   Stampa, per ogni destinazione, la voce JSON pronta da incollare nel file
   `--external-delivery-destinations` del Box — sostituisci
   `<this-server-address>` nell'`url` stampato con l'indirizzo reale
   raggiungibile di questo server (**non** `127.0.0.1` — la guardia SSRF del
   Box, `node/src/url-safety.ts`, rifiuta apposta loopback/indirizzi privati).

3. Aggiungi quella voce al file destinazioni del Box e (ri)avvia il Box con
   `--external-delivery-destinations <quel file>`.

4. Dall'app mobile ARALD, apri "Invia a un'organizzazione" — l'etichetta
   appare non appena la directory si propaga — scrivi un messaggio o
   allega un file, invia.

### Provarlo senza un servizio webhook reale

`--fake-webhook` avvia un webhook finto in-process e ci punta ogni
destinazione (ognuna sul proprio path, `/<destinationId>`) invece del vero
`webhookUrl` configurato — utile per confermare che l'intera pipeline (Box →
relay → decifra → webhook) funzioni prima di configurare un servizio reale.
Nessuna richiesta HTTP reale viene mai inviata a un servizio esterno.

```bash
npm run webhook-relay -- --config relay.json --fake-webhook
```

## Limitazione nota: una consegna ripetuta potrebbe (raramente) essere inviata due volte

`ExternalDeliveryQueue` sul Box rimuove una entry solo dopo una risposta 2xx.
Se questo relay invia con successo la richiesta al webhook ma la sua risposta
non arriva mai al Box (un intoppo di rete su questo lato, non della mesh), il
Box riproverà la stessa identica sottomissione sigillata più tardi. Questo
relay deduplica ricordando le ultime 500 consegne riuscite (con hash dei byte
sigillati, che restano identici tra i retry della stessa consegna) — un
retry entro quella finestra è un no-op, non una seconda richiesta al webhook.
Stessa mitigazione best-effort, non una garanzia, di `whatsapp-relay/`/
`email-relay/`.
