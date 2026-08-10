# gateway/internet/

Non ancora implementato — Milestone 11-12 ([`docs/roadmap.md`](../../docs/roadmap.md)).

Nodo con `INTERNET_GATEWAY = true` ([`docs/SPECIFICATION.md` §38](../../docs/SPECIFICATION.md#38-gateway-internet)): scarica, aggiorna e sincronizza contenuti quando una connessione Internet è disponibile, e propaga gli aggiornamenti nella mesh. È la componente che realizza il modello di "Internet intermittente" (§83, §100-101). Dipende dallo store-and-forward (Milestone 12) per gestire le richieste pendenti quando Internet non è disponibile.
