# gateway/nomad/

Traduce richieste ARALD (`content://wiki/italia`, `service://ai`, `service://kiwix-search`, ...) nell'API locale di [Project NOMAD](https://github.com/Crosstalk-Solutions/project-nomad) (Kiwix, Ollama, Qdrant, Kolibri, mappe, ...). Vedi [`docs/SPECIFICATION.md` §37, §70](../../docs/SPECIFICATION.md#37-integrazione-con-project-nomad) e [`docs/reuse-vs-new.md`](../../docs/reuse-vs-new.md) per la distinzione tra ciò che NOMAD già offre e ciò che questo gateway deve costruire.

**Nota sul nome**: questa cartella si chiama `nomad` perché parla con Project NOMAD, un progetto esterno non correlato — non ha a che fare col vecchio nome di questo stesso progetto ("Nomad-Net", rinominato **ARALD** il 4 settembre 2026, vedi `docs/due-diligence-naming-2026-09-04.md`). **Se questa dipendenza da Project NOMAD dovesse essere in futuro rimossa** (ipotesi aperta, non ancora decisa — vedi `docs/next-steps.md`, "Ipotesi di indipendenza da Project NOMAD"), questa cartella andrebbe rivalutata di conseguenza: oggi il nome è corretto perché la dipendenza è reale, non un impegno permanente a mantenerla.

**Stato**: mockato — implementato e testato contro finti server locali, mai collegato a un'istanza reale (bloccato su Docker/un'istanza raggiungibile, non disponibili in questo ambiente). Vedi [`docs/security.md`](../../docs/security.md) per il dettaglio completo. **Aggiornamento 30 settembre 2026**: `KiwixGateway` non parla più con un'ipotetica API di Project NOMAD (mai verificata, inventata per il prototipo) ma con la vera API di un'istanza `kiwix-serve` nuda, verificata con accesso web reale contro `kiwix-tools`' `docs/kiwix-serve.rst` — vedi il doc comment della classe e `docs/next-steps.md` ("Ipotesi di indipendenza da Project NOMAD") per cosa è confermato e cosa resta da verificare (in particolare, i nomi esatti dei campi JSON di `/suggest`).

Non è nel workspace npm (come `tools/simulator/`): importa `node/src/*` con percorsi relativi.

| File | Cosa fa |
|---|---|
| `kiwix-gateway.ts` | `KiwixGateway` — parla con un vero `kiwix-serve`. `publishArticle(path)` pubblica un singolo articolo noto via `publishContent()` (`content://...`) — nessun sync di massa possibile, kiwix-serve non ha un endpoint per elencare tutti gli articoli di un libro; `registerSearchService()` registra `service://kiwix-search`, proxy live a `/suggest` senza cache |
| `fake-kiwix-server.ts` | `FakeKiwixServer` — sostituisce un `kiwix-serve` reale nei test/demo, modella `GET /content/{book}/{path}` e `GET /suggest?content={book}&term={q}` |
| `ai-gateway.ts` | `AiGateway` — `registerAiService()` registra `service://ai` (spec §37: un dispositivo poco potente chiede alla rete una risposta generata da un'IA locale), proxy live a un backend Ollama senza cache — richiede un `model` esplicito (campo obbligatorio della vera API Ollama) |
| `fake-ollama-server.ts` | `FakeOllamaServer` — sostituisce un'istanza Ollama reale nei test/demo (`POST /api/generate`, risposte pre-registrate per parola chiave), valida `model` come farebbe la vera API |
| `cli.ts` | Demo eseguibile (`npm run gateway:demo`), avvia i gateway contro i rispettivi fake server a meno di `--kiwix-url`/`--kiwix-book`/`--ai-url`/`--ai-model` |

**Prerequisito per la forma reale**: un'istanza `kiwix-serve`/Ollama raggiungibile dal nodo che ospita questo gateway — non più necessariamente "dietro Project NOMAD": `KiwixGateway`/`AiGateway` puntano a un `baseUrl` qualunque, reale o mediato da NOMAD indifferentemente.
