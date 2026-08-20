# gateway/nomad/

Traduce richieste Nomad-Net (`content://wiki/italia`, `service://ai`, `service://kiwix-search`, ...) nell'API locale di [Project NOMAD](https://github.com/Crosstalk-Solutions/project-nomad) (Kiwix, Ollama, Qdrant, Kolibri, mappe, ...). Vedi [`docs/SPECIFICATION.md` §37, §70](../../docs/SPECIFICATION.md#37-integrazione-con-project-nomad) e [`docs/reuse-vs-new.md`](../../docs/reuse-vs-new.md) per la distinzione tra ciò che NOMAD già offre e ciò che questo gateway deve costruire.

**Stato**: mockato — implementato e testato (seguito audit, Slice 9-10) contro finti server locali, non ancora collegato a un'istanza reale di Project NOMAD (bloccato su Docker + un'istanza raggiungibile, non disponibili in questo ambiente). Vedi [`docs/security.md`](../../docs/security.md) bug #19-20 e [`docs/next-steps.md`](../../docs/next-steps.md) Opzione B per il dettaglio completo.

Non è nel workspace npm (come `tools/simulator/`): importa `node/src/*` con percorsi relativi.

| File | Cosa fa |
|---|---|
| `kiwix-gateway.ts` | `KiwixGateway` — `syncCatalog()` pubblica il catalogo articoli via `publishContent()` (`content://...`); `registerSearchService()` registra `service://kiwix-search`, proxy live a NOMAD senza cache |
| `fake-nomad-server.ts` | `FakeNomadServer` — sostituisce Project NOMAD/Kiwix reale nei test/demo (`GET /api/articles`, `GET /api/articles/:path`, `GET /api/search`) |
| `ai-gateway.ts` | `AiGateway` — `registerAiService()` registra `service://ai` (spec §37: un dispositivo poco potente chiede alla rete una risposta generata da un'IA locale), proxy live a un backend Ollama senza cache |
| `fake-ollama-server.ts` | `FakeOllamaServer` — sostituisce un'istanza Ollama reale nei test/demo (`POST /api/generate`, risposte pre-registrate per parola chiave) |
| `cli.ts` | Demo eseguibile (`npm run gateway:demo`), avvia entrambi i gateway contro i rispettivi fake server a meno di `--nomad-url`/`--ai-url` |

**Prerequisito per la forma reale**: un'istanza di Project NOMAD in esecuzione (Docker, sistema Debian-based) raggiungibile dal nodo che ospita questo gateway. Fino ad allora, `KiwixGateway`/`AiGateway` puntano a un `baseUrl` qualunque — passare da mock a reale significa solo cambiare quel `baseUrl`, l'adapter e il protocollo Nomad-Net esposto non cambiano.
