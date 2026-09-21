# Email relay — a "consegna esterna differita" destination

A small, independent service — **outside the ARALD mesh entirely** — that an
operator runs on their own always-connected server. It's the "destination"
side of ARALD's [external delivery](../docs/service-catalog.md#consegna-esterna-differita-file-store-and-forward-verso-lesterno)
mechanism (`node/src/external-delivery.ts`), same shape as `whatsapp-relay/`:
an ARALD Box POSTs an end-to-end-sealed blob to this server once it has
internet access; this server decrypts it (only it holds the matching
private key) and sends the plaintext as a plain-text email to one fixed
address.

**No mesh protocol changes were needed for this.** The Box only ever
transports opaque bytes — "email" is entirely a choice of what runs on the
receiving end.

## What this is not (v1 scope)

Text only, no attachment — a deliberate scope decision to match
`whatsapp-relay/`'s shape exactly, rather than inventing a structured
envelope (subject/body/attachment) up front. If attachments turn out to be
needed, that's a follow-up, not part of this piece.

## How it sends email

A minimal SMTP client written from scratch (`smtp-client.ts`, no npm
dependency) — connects with **implicit TLS** (SMTPS, port 465 by default,
not STARTTLS on 587) and authenticates with `AUTH PLAIN`. Works with any
SMTP account that supports these (Gmail with an
[app password](https://myaccount.google.com/apppasswords) included) — no
new account to open, no vendor lock-in.

## Character encoding

The body is quoted-printable-encoded (RFC 2045 §6.7, hand-written, no
dependency) before being sent — this keeps the message 7-bit-clean
unconditionally, so accented text (Italian included — "città", "è
arrivato") survives a strict receiving mail server without needing to
negotiate the 8BITMIME extension first. This is why a plain-text message
containing such characters may show `=XX` escape sequences if you ever
inspect the raw wire bytes directly (e.g. via `fake-smtp-server.ts` in a
test) — any real mail client decodes this transparently, per the
`Content-Transfer-Encoding: quoted-printable` header declared alongside it.

## ⚠️ Not verified against a real SMTP server

Written and tested only against `fake-smtp-server.ts` in this same
directory — this environment has no internet access, so the real command
sequence has never touched an actual mail server. The SMTP commands used
(`EHLO`/`AUTH PLAIN`/`MAIL FROM`/`RCPT TO`/`DATA`) are standard (RFC 5321),
but double-check delivery against your real provider before relying on it.

## Setup

You need an SMTP account with implicit-TLS access (port 465) — e.g. a
Gmail address with an
[app password](https://myaccount.google.com/apppasswords) (`smtp.gmail.com`,
port 465), or your organization's own mail server. Getting one is outside
this repository's scope.

1. Create a config file, e.g. `relay.json`:

   ```json
   {
     "port": 8092,
     "smtp": { "host": "smtp.gmail.com", "port": 465, "username": "you@gmail.com", "password": "<app password>" },
     "fromAddress": "you@gmail.com",
     "destinations": [
       { "destinationId": "hq-report", "label": "Email: Sede centrale", "toAddress": "sede@organizzazione.org", "keyFile": "./hq-report.key.json" }
     ]
   }
   ```

   `subject` is optional per destination (defaults to "Message via ARALD
   mesh"). `keyFile` is where this relay persists its own X25519 key pair
   for that destination — generated automatically on first run, **back it
   up like any other private key** (losing it means losing the ability to
   decrypt anything already queued toward it on a Box).

2. Run it:

   ```bash
   npm run email-relay -- --config relay.json
   ```

   It prints, for each destination, a ready-to-paste JSON entry for the
   Box's own `--external-delivery-destinations` file — replace
   `<this-server-address>` in the printed `url` with this server's actual
   reachable address (**not** `127.0.0.1` — the Box's own SSRF guard,
   `node/src/url-safety.ts`, rejects loopback/private addresses on
   purpose).

3. Add that printed entry to the Box's destinations file and (re)start the
   Box with `--external-delivery-destinations <that file>`.

4. From the ARALD mobile app, open "Invia a un'organizzazione" — the new
   label appears once the directory propagates — type a message, send.

### Trying it without a real mail account

`--fake-smtp` starts an in-process fake SMTP server (TLS, using the
committed test certificate under `tests/helpers/fixtures/`) and points the
relay at it instead — useful to confirm the whole pipeline (Box → relay →
decrypt → "email") works before setting up real credentials. No real email
is ever sent.

```bash
npm run email-relay -- --config relay.json --fake-smtp
```

## Known limitation: a retried delivery could (rarely) double-send

Same limitation and same mitigation as `whatsapp-relay/`: `ExternalDeliveryQueue`
on the Box only removes an entry after a 2xx response, so a lost response
after a successful send could cause a Box retry to resend the identical
email. This relay deduplicates by remembering the last 500
successfully-delivered submissions (keyed by a hash of their sealed bytes,
identical across retries of the same delivery) — a retry within that window
is a no-op. Best-effort, not a guarantee, consistent with
`external-delivery.ts`'s own accepted design.
