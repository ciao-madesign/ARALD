# `service-stack/` — stack Docker indipendente da Project NOMAD

Avvia i backend reali che `gateway/nomad/` interroga via HTTP — **kiwix-serve** e **Ollama** — usando le loro immagini Docker ufficiali e pubbliche, senza alcuna dipendenza dal sorgente di Project NOMAD (un progetto esterno, mai reso disponibile in questo ambiente, che la specifica stessa definisce "non dichiarato stabile", spec §4).

## Perché questo file esiste

`gateway/nomad/kiwix-gateway.ts` e `gateway/nomad/ai-gateway.ts` parlano già con le vere API di `kiwix-serve`/Ollama (`docs/security.md` voce #97, 30 settembre 2026) — non con un'API inventata da Project NOMAD. Questo significa che **qualunque istanza reale** di questi due programmi funziona, comunque sia stata avviata: non serve il pacchetto "Project NOMAD" nel suo insieme, solo i due programmi open source che ci sono effettivamente sotto. `docker-compose.yml` in questa cartella li avvia entrambi con le loro immagini ufficiali:

| Servizio | Immagine | Fonte verificata |
|---|---|---|
| kiwix-serve | `ghcr.io/kiwix/kiwix-serve` | [`kiwix/kiwix-tools`, `docker/server/README.md`](https://github.com/kiwix/kiwix-tools/blob/main/docker/server/README.md) — accesso web reale, 30 settembre 2026 |
| Ollama | `ollama/ollama` | [Ollama Docker Hub](https://hub.docker.com/r/ollama/ollama) — accesso web reale, 30 settembre 2026 |

Non incluso: **Flatnotes** — decisione esplicita dell'utente (30 settembre 2026, "non è essenziale, possiamo pensare di aggiungerlo più avanti"). `FlatnotesGateway` parla ancora con un'API inventata mai verificata (stesso stato del vecchio `KiwixGateway` prima della voce #97) — va riscritto per primo (`docs/next-steps.md`), poi questo file guadagna un terzo servizio con l'immagine ufficiale `dullage/flatnotes` (licenza MIT, verificata anch'essa il 30 settembre 2026).

## Cosa NON fa questo file

- **Non scarica ZIM/modelli AI** — sono dati reali, spesso enormi (GB), che l'operatore procura da sé (`./data/zim/*.zim`, `docker exec arald-ollama ollama pull <modello>`). Bring-up fisico, lavoro privato dell'utente per convenzione di questo repository (`CLAUDE.md`), mai uno script automatico qui.
- **Non sostituisce `nomad-hub/`** — `nomad-hub/` amministra Docker in generale (avvio/arresto/log/riavvio host) su qualunque host esegua *qualunque* container, questo compreso; non ha bisogno di alcuna modifica per gestire questo stack invece del vecchio piano NOMAD.
- **Non è mai stato eseguito in questo ambiente** — nessun demone Docker raggiungibile in questa sessione (`docker info` fallisce sul socket). Sintassi/porte/volumi verificati contro la documentazione ufficiale di ciascun progetto (tabella sopra), non contro un avvio reale. Verificare con un vero `docker compose up -d` prima di considerarlo pronto per un deployment.

## Uso previsto

```bash
cd service-stack
# popolare ./data/zim/ con almeno un file .zim (lavoro dell'operatore, non di questo repo)
docker compose up -d
docker exec arald-ollama ollama pull llama3.2   # o il modello scelto

# poi, dalla radice del repo:
npm run gateway:demo -- --kiwix-url http://127.0.0.1:8080 --kiwix-book <nome-libro> --ai-url http://127.0.0.1:11434 --ai-model llama3.2
```

`<nome-libro>` è il nome che kiwix-serve deriva dal file ZIM caricato (verificabile interrogando l'istanza avviata, es. la sua pagina di ricerca) — nessun default corretto per ogni caso, `gateway/nomad/cli.ts` non ne indovina uno (`--kiwix-book`, default `"wiki"`, quasi certamente da sovrascrivere con un file reale).
