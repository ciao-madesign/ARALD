# WhatsApp relay — a "consegna esterna differita" destination

A small, independent service — **outside the ARALD mesh entirely** — that an
operator runs on their own always-connected server. It's the "destination"
side of ARALD's [external delivery](../docs/service-catalog.md#consegna-esterna-differita-file-store-and-forward-verso-lesterno)
mechanism (`node/src/external-delivery.ts`): an ARALD Box POSTs an
end-to-end-sealed blob to this server once it has internet access; this
server decrypts it (only it holds the matching private key) and sends the
plaintext as a WhatsApp text message to one fixed contact.

**No mesh protocol changes were needed for this.** The Box only ever
transports opaque bytes — "WhatsApp" is entirely a choice of what runs on the
receiving end. The same pattern generalizes to any other point-in-time
external action (an email, a post to a channel, an upload) by writing a
different receiver.

## What this is not

Not a live WhatsApp bridge. WhatsApp is end-to-end encrypted on a closed
protocol — you cannot relay someone else's WhatsApp session through a mesh
network, and this doesn't try to. It sends **one text message to one
pre-configured contact**, the same way `external-delivery.ts` was designed
for a report or a file: fire it into the mesh, it lands when connectivity
allows.

## ⚠️ Not verified against the real Meta API

The WhatsApp Business Cloud API request/response shape used in
`whatsapp-client.ts` was reconstructed from training knowledge, not checked
against Meta's live documentation or a real API call — this environment has
no internet access. `fake-whatsapp-cloud-server.ts` models that same shape
for tests, so the client and its test double are at least verified to agree
with *each other*. **Double-check the current Meta Graph API version and
endpoint shape before relying on this against the real API.**

## Setup

You need, from Meta: a WhatsApp Business Cloud API **phone number ID** and
an **access token**. Getting those is outside this repository's scope (an
institutional/account setup step, not a technical one this codebase can do
for you).

1. Create a config file, e.g. `relay.json`:

   ```json
   {
     "port": 8091,
     "whatsapp": { "phoneNumberId": "<from Meta>", "accessToken": "<from Meta>" },
     "destinations": [
       { "destinationId": "mario-whatsapp", "label": "WhatsApp: Mario Rossi", "toNumber": "391234567890", "keyFile": "./mario.key.json" }
     ]
   }
   ```

   `toNumber` is E.164 digits only (no `+`). `keyFile` is where this relay
   persists its own X25519 key pair for that destination — generated
   automatically on first run, **back it up like any other private key**
   (losing it means losing the ability to decrypt anything already queued
   toward it on a Box).

2. Run it:

   ```bash
   npm run whatsapp-relay -- --config relay.json
   ```

   It prints, for each destination, a ready-to-paste JSON entry for the
   Box's own `--external-delivery-destinations` file — replace
   `<this-server-address>` in the printed `url` with this server's actual
   reachable address (**not** `127.0.0.1` — it needs to be reachable from
   wherever the Box runs, and the Box's own SSRF guard,
   `node/src/url-safety.ts`, rejects loopback/private addresses on purpose).

3. Add that printed entry to the Box's destinations file and (re)start the
   Box with `--external-delivery-destinations <that file>`.

4. From the ARALD mobile app, open "Invia a un'organizzazione" — the new
   label appears once the directory propagates — type a message, send.

### Trying it without a Meta account

`--fake-whatsapp` starts an in-process fake Meta API and points this relay
at it instead — useful to confirm the whole pipeline (Box → relay → decrypt
→ "WhatsApp") works before setting up real credentials. No real message is
ever sent.

```bash
npm run whatsapp-relay -- --config relay.json --fake-whatsapp
```

## Known limitation: a retried delivery could (rarely) double-send

`ExternalDeliveryQueue` on the Box only removes an entry after a 2xx
response. If this relay sends the WhatsApp message successfully but its
response never reaches the Box (a network hiccup on this server's side, not
the mesh's), the Box will retry the exact same sealed submission later. This
relay deduplicates by remembering the last 500 successfully-delivered
submissions (keyed by a hash of their sealed bytes, which stay identical
across retries of the same delivery) — a retry within that window is a
no-op, not a second WhatsApp message. Older retries than that window aren't
covered; this is a best-effort mitigation, not a guarantee, consistent with
`external-delivery.ts`'s own accepted "best-effort, no ack" design.
