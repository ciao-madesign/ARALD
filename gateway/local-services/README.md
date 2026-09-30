# gateway/local-services/

Traduce richieste ARALD (`content://wiki/italia`, `service://ai`, `service://kiwix-search`, ...) nell'API reale di ciascun backend locale che ospita — Kiwix, Ollama, Flatnotes — più due servizi che non hanno alcun backend esterno (`news-gateway.ts`, `internet-gateway.ts`). Vedi [`docs/service-catalog.md`](../../docs/service-catalog.md) per l'inventario completo dei servizi e [`docs/reuse-vs-new.md`](../../docs/reuse-vs-new.md) per cosa era originariamente ispirato a Project NOMAD.

**Nota sul nome, rinominata da `gateway/nomad/` il 30 settembre 2026**: questa cartella si chiamava `nomad` perché in origine parlava (o avrebbe dovuto parlare) con [Project NOMAD](https://github.com/Crosstalk-Solutions/project-nomad), un progetto esterno non correlato al vecchio nome di questo stesso progetto ("Nomad-Net", rinominato **ARALD** il 4 settembre 2026 — coincidenza di nomi già chiarita allora, vedi `docs/due-diligence-naming-2026-09-04.md`). Quella dipendenza è stata nel frattempo azzerata: ogni gateway qui dentro parla con la vera API del proprio backend diretto (Kiwix, Ollama, Flatnotes), mai con un'API di Project NOMAD — la due-diligence del 4 settembre aveva esplicitamente lasciato aperta questa possibilità ("se la dipendenza dovesse essere rimossa, la cartella andrebbe rivalutata"), decisione presa il 30 settembre 2026 (`docs/next-steps.md`, "Indipendenza da Project NOMAD").

Non è nel workspace npm (come `tools/simulator/`): importa `node/src/*` con percorsi relativi.

| File | Cosa fa |
|---|---|
| `kiwix-gateway.ts` | `KiwixGateway` — parla con un vero `kiwix-serve`. `fetchNote()`/`publishArticle(path)` pubblica un singolo articolo noto via `publishContent()` (`content://...`) — nessun sync di massa possibile, kiwix-serve non ha un endpoint per elencare tutti gli articoli di un libro; `registerSearchService()` registra `service://kiwix-search` (proxy live a `/suggest`), `registerFetchService()` registra `service://kiwix-fetch` (trasforma un risultato di ricerca in contenuto) |
| `fake-kiwix-server.ts` | `FakeKiwixServer` — sostituisce un `kiwix-serve` reale nei test/demo, modella `GET /content/{book}/{path}` e `GET /suggest?content={book}&term={q}` |
| `ai-gateway.ts` | `AiGateway` — `registerAiService()` registra `service://ai` (spec §37: un dispositivo poco potente chiede alla rete una risposta generata da un'IA locale), proxy live a un backend Ollama senza cache — richiede un `model` esplicito (campo obbligatorio della vera API Ollama) |
| `fake-ollama-server.ts` | `FakeOllamaServer` — sostituisce un'istanza Ollama reale nei test/demo (`POST /api/generate`, risposte pre-registrate per parola chiave), valida `model` come farebbe la vera API |
| `news-gateway.ts` | `NewsGateway` — ingerisce un vero feed RSS/Atom (`rss-feed.ts`) direttamente, nessun backend NOMAD coinvolto. `service://news`/`service://emergency-news`, digest generato componendo `service://ai` |
| `rss-feed.ts` | Parser RSS/Atom scritto da zero, nessuna dipendenza esterna |
| `translate-gateway.ts` | `service://translation` — compone `service://ai`, nessun backend proprio |
| `internet-gateway.ts` | `service://internet-fetch` — fetch diretto verso Internet, allowlist host + guardia SSRF (`node/src/url-safety.ts`), nessun backend NOMAD coinvolto |
| `flatnotes-gateway.ts` | `FlatnotesGateway` — parla con un vero Flatnotes. Note identificate per **titolo**, non per un "path". `registerSearchService()`/`registerFetchService()`/`registerCreateService()` registrano `service://flatnotes-search`/`-fetch`/`-create` |
| `fake-flatnotes-server.ts` | `FakeFlatnotesServer` — sostituisce un Flatnotes reale nei test/demo, modella `GET /api/notes/{title}`, `POST /api/notes`, `GET /api/search?term=` |
| `fetch-bounded.ts` | Utility condivisa (fetch con limite di dimensione) |
| `cli.ts` | Demo eseguibile (`npm run gateway:demo`), avvia i gateway contro i rispettivi fake server a meno di `--kiwix-url`/`--kiwix-book`/`--ai-url`/`--ai-model`/`--flatnotes-url`/`--news-url`/`--internet-fetch` |

**Stato**: `KiwixGateway`/`AiGateway`/`FlatnotesGateway` parlano tutti con le vere API dei rispettivi backend, verificate con accesso web reale (`docs/security.md` voci #97/#98/#100) — non con un'API di Project NOMAD. `service-stack/docker-compose.yml` (radice del repo) li avvia tutti e tre con le loro immagini Docker ufficiali pubbliche, senza alcun sorgente esterno da procurarsi. Nessuno dei tre è mai stato verificato contro un'istanza reale in questo ambiente (nessun demone Docker raggiungibile in questa sessione) — solo contro i rispettivi `Fake*Server`. `NewsGateway`/`InternetGateway` sono indipendenti per costruzione fin dall'inizio (mai passati da un'API NOMAD).
