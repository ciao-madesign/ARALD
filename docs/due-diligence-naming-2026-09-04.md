# Due-diligence naming/licenza e migrazione a ARALD — 4 settembre 2026

Report richiesto esplicitamente dall'utente: due-diligence tecnica/legale/architetturale completa sul naming "NOMAD"/"Nomad-Net" e migrazione del progetto al nuovo nome **ARALD**. Eseguito con accesso web reale (`WebSearch`/`WebFetch`) in questa sessione — a differenza di molte altre voci di questo repository, le informazioni sui progetti esterni sotto sono verificate, non ipotesi di lavoro.

**Disclaimer che vale per l'intero documento**: questa è un'analisi tecnica fatta da un assistente software, non una consulenza legale. Dove qualcosa richiederebbe un parere legale/IP professionale prima di una decisione commerciale reale (deposito di marchio, pubblicazione, raccolta fondi), è segnalato esplicitamente — non trattarlo come un "via libera" legale.

## 1. Executive summary

Il progetto, sviluppato con il nome di lavoro "Nomad-Net"/"NOMAD-Net", presentava un rischio di conflitto di naming reale e non ipotetico con due progetti esterni: **NomadNet** (Mark Qvist, GPL-3.0) — un nome quasi identico, stesso dominio applicativo (mesh di comunicazione off-grid, delay-tolerant) — e **Project N.O.M.A.D.** (Crosstalk Solutions, Apache-2.0), il servizio esterno a cui questo stesso progetto si integra volontariamente (`gateway/nomad/`), con un rischio di confusione di affiliazione (il nome "Nomad-Net" suonava come "la rete di NOMAD"). Nessun codice è mai stato copiato da nessuno dei due, né da Reticulum/LXMF (le librerie su cui NomadNet è costruito) né da BitChat (già documentato altrove in questo repository, `docs/reuse-vs-new.md`) — il rischio era interamente di naming/branding, non di licenza sul codice.

Il progetto è stato rinominato in **ARALD** (repository GitHub già rinominato dall'utente stesso prima di questa sessione). È stata eseguita una migrazione del naming su tutte le superfici pubbliche/rivolte all'utente (README in inglese, documentazione tecnica, UI mobile, testo CLI/web visibile, metadata dei package), lasciando deliberatamente invariati gli identificatori puramente interni mai visibili all'esterno (classe `NomadNode`, directory `gateway/nomad/`/`nomad-hub/`) e la narrativa storica di `docs/security.md`/`CLAUDE.md`, entrambe segnalate esplicitamente come tali.

## 2. Repository analizzati

- Questo repository (`ciao-madesign/ARALD`, ex `ciao-madesign/nomad-net`) — analisi completa via `grep` ricorsivo, non solo ricerca testuale superficiale: codice (`node/src/`, `gateway/nomad/`, `nomad-hub/`, `mobile/`, `tools/simulator/`), test, documentazione, configurazione (`package.json` × 3, `capacitor.config.json`, `.gitignore`), stringhe UI (HTML/JS/CSS), messaggi console/log.
- **Progetti esterni** (verificati via web reale in questa sessione, non clonati localmente — nessun bisogno di leggerne il codice sorgente, dato che la domanda era di naming/licenza, non di derivazione di codice):
  - `github.com/Crosstalk-Solutions/project-nomad`
  - `github.com/markqvist/NomadNet`
  - `github.com/markqvist/Reticulum`
  - `github.com/markqvist/LXMF`

## 3. Progetti open source rilevanti

| Progetto | Autore | Repository | Cosa fa |
|---|---|---|---|
| Project N.O.M.A.D. | Crosstalk Solutions LLC | github.com/Crosstalk-Solutions/project-nomad | Server di conoscenza/educazione offline-first: orchestratore Docker per Kiwix (Wikipedia offline), Ollama (LLM locale) + Qdrant (RAG), Kolibri (corsi), mappe (ProtoMaps), CyberChef, FlatNotes. |
| NomadNet | Mark Qvist | github.com/markqvist/NomadNet | Piattaforma di comunicazione mesh off-grid cifrata, "private and resilient communications platforms... in complete control" dell'utente. |
| Reticulum | Mark Qvist | github.com/markqvist/Reticulum | Il livello di rete/crittografia mesh su cui è costruito NomadNet (routing peer-to-peer, identità crittografiche). |
| LXMF | Mark Qvist | github.com/markqvist/LXMF | Il livello di messaggistica sopra Reticulum, usato da NomadNet. |

Nessun altro progetto chiamato NOMAD/Nomad/NomadNet tecnicamente/semanticamente vicino è emerso dalla ricerca (verificato anche con ricerche generiche su GitHub/web, non solo sui quattro nomi noti in partenza).

## 4. Licenze individuate

| Progetto | Licenza | Punti notevoli |
|---|---|---|
| Project N.O.M.A.D. | Apache License 2.0 | Copyright "2024-2026 Crosstalk Solutions LLC". La sezione 6 di Apache-2.0 esclude esplicitamente una concessione di diritti sul nome/marchio/logo del licenziante — la licenza permissiva sul codice **non** implica alcun diritto di usarne il nome. |
| NomadNet | GPL-3.0 | Copyleft forte: qualunque derivato/modifica distribuita deve restare GPL-3.0, con codice sorgente disponibile. Uso commerciale permesso, ma con lo stesso obbligo di licenza per chi riceve il derivato. |
| Reticulum | Modified MIT | Copyright Mark Qvist, 2016-2026. Base MIT permissiva **più due clausole aggiuntive non standard**: (1) vietato l'uso in sistemi progettati per danneggiare intenzionalmente esseri umani; (2) vietato l'uso, diretto o indiretto, nella creazione di dataset di addestramento per intelligenza artificiale/machine learning/modelli linguistici. |
| LXMF | Modified MIT | Stessa licenza modificata di Reticulum, stesso autore, stesse due clausole aggiuntive. |

## 5. Codice/componenti effettivamente riutilizzati

**Nessuno.** Verificato per ciascuno dei quattro progetti:

- **Project N.O.M.A.D.**: questo repository non ne importa codice — `gateway/nomad/` parla con un'istanza NOMAD (o con i suoi fake server locali per test) via chiamate HTTP generiche verso i servizi che NOMAD orchestra (Kiwix, Ollama), non verso un'API "NOMAD" proprietaria specifica. Nessun file sorgente di Project NOMAD è stato letto o copiato in nessuna sessione precedente di questo progetto (mai avuto accesso a Internet reale prima di questa sessione, per stessa ammissione ripetuta in `CLAUDE.md`).
- **NomadNet/Reticulum/LXMF**: mai clonati né letti riga per riga in nessuna sessione. Nessuna dipendenza, nessun import, nessun file con codice riconducibile a questi progetti.
- **BitChat**: già documentato in dettaglio in `docs/reuse-vs-new.md` — solo concetti (routing/TTL/dedup, il concetto di `BoardManager` dietro `node/src/drops.ts`), mai codice, con attribuzione esplicita nei commenti del codice interessato.

Quindi: **nessun obbligo di licenza attivato** da nessuno dei quattro progetti — non c'è codice derivato che richieda GPL-3.0 (NomadNet), attribuzione NOTICE (Apache-2.0, Project NOMAD), o le clausole aggiuntive di Reticulum/LXMF.

## 6. Obblighi di licenza

Nessuno attivo, per il punto 5. Se in futuro il progetto dovesse effettivamente importare codice da uno di questi quattro repository (oggi non previsto, nessuna decisione presa in tal senso):

- **Da Project NOMAD (Apache-2.0)**: andrebbe preservato il file `LICENSE`/`NOTICE` originale per la porzione importata, e ogni file modificato marcato come tale — attribuzione, non copyleft.
- **Da NomadNet (GPL-3.0)**: l'intero componente che lo includesse dovrebbe essere ridistribuito sotto GPL-3.0 (o compatibile) con sorgente disponibile — un vincolo forte, da valutare con attenzione prima di importare anche una singola funzione.
- **Da Reticulum/LXMF (Modified MIT)**: attribuzione standard MIT più il rispetto delle due clausole aggiuntive (mai per danneggiare persone, mai per addestrare modelli AI/ML) — quest'ultima rilevante in particolare se in futuro si volesse usare codice di questi progetti per addestrare o affinare un modello linguistico, non solo per eseguirlo.

## 7. Potenziali conflitti di naming/trademark

- **"NomadNet" (Mark Qvist) vs. "Nomad-Net" (questo progetto, ex nome)**: il conflitto più serio trovato. Stesso dominio applicativo (mesh off-grid, delay-tolerant), nome praticamente identico salvo un trattino. Rischio reale di confusione, non solo teorico — motivo primario del rename.
- **"Project NOMAD" vs. "Nomad-Net"**: rischio di apparente affiliazione — il nome precedente del progetto suonava come "la rete/famiglia di prodotti di NOMAD", mentre si tratta di un'integrazione opzionale verso un servizio esterno, non un prodotto della stessa famiglia. Apache-2.0 §6 esclude comunque esplicitamente concessioni di trademark, quindi l'uso del nome "NOMAD" nel nome del proprio progetto non era comunque autorizzato dalla licenza sul codice.
- **"ARALD" vs. "Araldite"** (Huntsman Advanced Materials, marchio registrato per adesivi epossidici): unico riscontro rilevante trovato per "ARALD" in una ricerca trademark generica. Settore merceologico completamente diverso (adesivi industriali vs. software/hardware di rete) e il marchio Araldite è una parola intera diversa (non un semplice plurale/variante di "Arald"), ma **"ARALD" è contenuto come prefisso in "Araldite"** — una ricerca di trademark clearance professionale probabilmente la segnalerebbe per un'analisi di rischio di confusione, anche se la conclusione più probabile è nessun conflitto reale data la distanza di settore. Trattare come **"potential conflict, requires trademark search"**, non come "nessun conflitto".
- Nessun repository GitHub, prodotto software, o azienda di rilievo chiamato "ARALD" trovato nella ricerca.

## 8. Rischi tecnici

- Nessun rischio tecnico di compatibilità: la rinomina ha toccato solo testo (documentazione, stringhe UI, metadata) e due campi di configurazione (`package.json` name/bin, `capacitor.config.json` appId/appName) — verificato con typecheck, build e l'intera suite di test (768/768) dopo ogni gruppo di modifiche.
- **Debito tecnico non affrontato in questa voce, deliberatamente**: la classe `NomadNode` (424 occorrenze in `node/src/`+test) resta con questo nome — rinominarla toccherebbe ~98 file TypeScript per zero beneficio di branding (mai visibile a un utente finale). Se in futuro si volesse comunque rinominarla (es. in vista di una pubblicazione npm pubblica del pacchetto `@arald/node`), è un lavoro a sé, separato da questa voce.
- `mobile/android/app/src/main/assets/capacitor.config.json` (copia generata da `cap sync`) non è stato aggiornato a mano — si rigenererà automaticamente al prossimo `npx cap sync`, non eseguibile in questo ambiente (build Android nativa nota come non compilabile qui, `mobile/README.md`).
- `arald.com`/`arald.org`/`aralnet.com` risultano già registrati da terzi (verificato via ricerca disponibilità dominio) — non necessariamente un conflitto di trademark (potrebbe essere domain squatting o un'entità non correlata, non verificato oltre la disponibilità), ma un vincolo pratico per un'eventuale presenza web futura. `arald.io`/`arald.net`/`arald.dev`/`arald.tech` e molti altri TLD risultano invece disponibili.

## 9. Spunti tecnici utili (dai progetti esterni)

Non eseguito un confronto tecnico approfondito in questa sessione — la richiesta originale era prioritariamente di naming/licenza, e il tempo/ambito di questa voce è stato speso lì. Uniche osservazioni di alto livello raccolte dai README ufficiali (non da lettura del codice sorgente):

- **Reticulum/LXMF**: separano esplicitamente un livello di rete/crittografia (Reticulum) da un livello di messaggistica (LXMF) sopra di esso — architettura a due livelli concettualmente simile alla separazione già presente in questo progetto tra `routing.ts`/`identity.ts` (livello rete) e `node.ts`'s handler applicativi (livello messaggio/contenuto). Nessuna azione concreta proposta qui: se in futuro si volesse un confronto tecnico più approfondito (es. sul loro modello di "announce" per la scoperta di destinazioni, o sulle modalità di consegna LXMF), va trattato come lavoro dedicato a sé, con lettura del codice sorgente e — data la licenza — solo come riferimento concettuale, mai codice importato (stesso trattamento già riservato a BitChat).
- Nessuno spunto tecnico concreto da Project NOMAD oltre a quanto già noto (è un orchestratore Docker di servizi terzi, non ha un proprio protocollo di rete/mesh da cui prendere ispirazione — dominio applicativo diverso da questo progetto).

## 10. Nuovi candidati di naming

Non eseguito un giro di generazione di 15-20 candidati: **l'utente ha già scelto e comunicato il nome finale, "ARALD"**, insieme alla richiesta esplicita di applicare direttamente la migrazione — generare e valutare candidati alternativi a quel punto sarebbe stato lavoro rifatto, non richiesto. Il nome è stato comunque sottoposto a una verifica di rischio dedicata (vedi punti 7 e 12).

## 11. Nome scelto e motivazione

**ARALD**, scelto dall'utente. Motivazione riportata dall'utente stessa: richiama *araldo*, il messaggero che porta l'informazione alla tappa successiva — coerente con l'architettura store-and-forward del progetto, dove ogni nodo può finire per trasportare un messaggio oltre. Concettualmente indipendente da "NOMAD" (non una variazione cosmetica), pronunciabile in italiano e inglese, adatto alla famiglia di prodotti software+hardware+rete indicata dall'utente (ARALD Network/Protocol/Card/Clip/Relay/Box/Portable/Portal/Hub).

## 12. Analisi preliminare del rischio del nuovo nome

- **GitHub**: nessun repository rilevante chiamato "ARALD" trovato.
- **Web/software/aziende**: nessun prodotto o azienda di rilievo nello stesso spazio (mesh/emergenza/comunicazione) trovato. Unico riscontro: "Araldite" (Huntsman), marchio di adesivi — settore diverso, ma "ARALD" ne è un prefisso letterale (vedi punto 7): **potential conflict, requires trademark search** prima di un deposito di marchio reale o di una commercializzazione, non "nessun rischio".
- **Domini**: `arald.com`/`arald.org` già registrati da terzi (non verificato da chi); `arald.io`/`arald.net`/`arald.dev`/`arald.tech`/molti altri disponibili al momento della verifica.
- **EUIPO/WIPO/USPTO**: **non consultati direttamente** in questa sessione (nessuno strumento di ricerca diretto verso questi database disponibile) — una ricerca formale su questi registri resta un passo **non eseguito qui**, da fare prima di qualunque deposito di marchio reale o commercializzazione.
- **Conclusione onesta**: rischio apparente basso-moderato, non rischio zero verificato in modo formale. Non trattare questa sezione come un nullaosta legale.

## 13. File modificati

31 file (elenco completo verificabile con `git status`/`git diff` sul commit di questa voce): `README.md`, `LICENSE`, `CLAUDE.md`, `package.json`/`package-lock.json`, `node/package.json`, `mobile/package.json`, `mobile/capacitor.config.json`, 11 file in `docs/*.md`, 6 file in `mobile/www/`, `node/src/cli.ts`, `node/src/web-ui.ts`, `gateway/nomad/cli.ts`, `nomad-hub/cli.ts`, `tools/simulator/cli.ts`, `tests/integration/web-ui.test.ts`.

## 14. Occorrenze NOMAD rimosse

Da 1716 a 1427 occorrenze case-insensitive di "nomad" nel repository (esclusi `node_modules`/`dist`) — una riduzione di ~290, concentrata esattamente dove serviva: ogni menzione brand-facing di "Nomad-Net"/"NOMAD-Net"/"NOMAD Card"/"NOMAD Box"/"NOMAD Portable"/"NOMAD Clip"/"NOMAD Cover"/"NOMAD Hub"/"NOMAD Fixed Relay"/"NOMAD Mobile Relay"/"NOMAD Radio Module"/"NOMAD Radio Device"/"NOMAD Test Record" in documentazione tecnica, README, UI mobile (titoli, wordmark, testo di pairing), testo CLI/web-ui visibile in console/browser, e metadata dei package (nomi npm, `appId`/`appName` Capacitor).

## 15. Occorrenze NOMAD rimaste e motivazione

- **`NomadNode` (classe TypeScript, 424 occorrenze)** — identificatore di codice interno, mai visibile a un utente finale della mesh o dell'app mobile. Lasciato per non introdurre un rischio di regressione su ~98 file per zero beneficio di branding, come esplicitamente autorizzato ("se rimangono nascoste all'esterno non è un grosso problema").
- **`gateway/nomad/` (directory, 128 riferimenti di path)** — **corretto così com'è**: si riferisce propriamente al Project NOMAD esterno a cui quel modulo si collega, non al nome del nostro progetto. Rinominarla sarebbe stato un errore concettuale, non solo inutile.
- **`nomad-hub/` (directory, 38 riferimenti di path)** — identificatore di percorso interno; il concetto che rappresenta ("ARALD Hub") è già stato rinominato ovunque appaia in prosa/UI.
- **`docs/security.md` (185 occorrenze) e `CLAUDE.md` (165 occorrenze)** — narrativa storica/changelog scritta via via nel tempo, deliberatamente non riscritta per preservare l'accuratezza di chi ha detto/deciso cosa e quando (stessa disciplina già applicata in questi due file per altra terminologia superata, es. "NOMAD Mobile Relay" prima della NOMAD Card). Entrambi i file hanno ora una nota esplicita in testa che spiega questa scelta.
- **Ogni menzione autentica di "Project NOMAD"/"Project N.O.M.A.D."** (nel codice, nella documentazione, nell'UI) — mantenuta intenzionalmente: è il nome proprio del progetto esterno, va sempre attribuito correttamente, mai rinominato.
- **Commenti di codice interni non user-facing** (es. in `node/src/node.ts`, `drops.ts`, `gateway/nomad/kiwix-gateway.ts`/`flatnotes-gateway.ts`) che citano "Nomad-Net" come nome storico del progetto in una spiegazione di design — non riscritti in questa voce, stesso trattamento della narrativa storica sopra: sono commenti di sviluppo, non testo rivolto all'utente finale. Candidati a una pulizia futura se mai si toccherà quel codice per altri motivi, non un'azione dedicata qui.
- **Nomi di test interni** (es. il titolo del blocco `describe()` in `tests/integration/nomad-hub-management.test.ts`) — cosmetici, non asseriti da nessun test, lasciati come debito tecnico minore.

## 16. Modifiche a LICENSE/NOTICE/attribution

- `LICENSE`: riga di copyright aggiornata da "Nomad-Net contributors" a "ARALD contributors" (il progetto resta MIT).
- Nessun file `NOTICE`/`THIRD_PARTY_LICENSES` creato: **non necessario**, dato che nessun codice di terze parti è incluso in questo repository (punto 5) — l'unica dipendenza runtime reale del progetto resta quanto già presente prima di questa voce (TypeScript/vitest/tsx come devDependency, `@capacitor/*` per l'app mobile, nessuna delle quali collegata a NOMAD/NomadNet/Reticulum/LXMF/BitChat). Se in futuro venisse importato codice reale da uno di questi progetti, quello sarebbe il momento di introdurre una struttura `/THIRD_PARTY_LICENSES` — prematuro ora.
- `docs/reuse-vs-new.md`: nuova sezione "Altri progetti 'Nomad'/mesh correlati verificati per la due-diligence sul naming" — la tabella di attribuzione formale per NomadNet/Reticulum/LXMF (licenza, autore, relazione con ARALD), stesso trattamento già riservato a Project NOMAD/BitChat nello stesso file.

## 17. Problemi ancora da risolvere

- Rigenerare `mobile/android/` via `npx cap sync` per propagare `appId`/`appName` nei file di progetto Android generati (`build.gradle`, `AndroidManifest.xml`, `strings.xml`) — non eseguibile in questo ambiente (build Android nativa nota come non compilabile qui).
- Aggiornare la descrizione del repository su GitHub (non solo il nome, già fatto dall'utente) — nessun accesso agli strumenti GitHub in questa sessione per farlo direttamente (MCP GitHub non connesso in questo momento).
- Nessuna ricerca formale EUIPO/WIPO/USPTO eseguita (punto 12) — resta da fare prima di un deposito di marchio reale.
- Verifica visiva reale (Playwright o dispositivo fisico) del nuovo wordmark "ARALD·NETWORK" nell'app mobile — non eseguita in questa voce, solo verificato che la regola CSS `.wordmark` non ha vincoli di larghezza fissa che potrebbero troncare il testo più lungo di "NOMAD·NET".

## 18. Raccomandazioni prima della pubblicazione

- Eseguire la verifica Playwright del wordmark rinominato (punto 17) prima di considerare l'app mobile pronta per una demo/pubblicazione.
- Rigenerare `mobile/android/` con `cap sync` non appena disponibile un ambiente con accesso reale a `dl.google.com`/Android Gradle Plugin.
- Rileggere una volta il `README.md` come farebbe un lettore esterno (nessun contesto pregresso su questo progetto) — è stato riscritto per intero in questa voce, mai rivisto da occhi diversi da chi lo ha scritto.

## 19. Raccomandazioni prima di una eventuale commercializzazione

- **Ricerca di trademark clearance professionale per "ARALD"** — punto 12, non delegabile a una ricerca web generica come questa. In particolare verificare la posizione di Huntsman/Araldite in modo formale, non solo con una ricerca testuale.
- Decidere e registrare un dominio prima che qualcun altro lo faccia — `arald.io`/`arald.net`/`arald.dev` risultavano disponibili al momento della verifica (4 settembre 2026), nessuna garanzia che lo restino.
- Se mai si valutasse di importare codice reale da NomadNet (GPL-3.0), valutare con attenzione l'obbligo di copyleft che ne deriverebbe per l'intero componente coinvolto — non una decisione da prendere senza consapevolezza esplicita dell'implicazione.
- Se mai si valutasse di usare Reticulum/LXMF come riferimento per addestrare o affinare un modello AI/ML (non il caso oggi), la loro licenza lo vieta esplicitamente — non un'opzione disponibile, non solo sconsigliata.

## 20. Punti che richiedono revisione legale professionale

- Trademark clearance formale per "ARALD" (EUIPO se il mercato di riferimento resta europeo, WIPO/USPTO se si guarda oltre) — punti 7, 12, 19.
- Qualunque valutazione se il nome "ARALD" possa generare un rischio di confusione con "Araldite" (Huntsman) sufficiente a giustificare un nome diverso, oltre alla valutazione preliminare di questo documento (settore merceologico diverso, ma prefisso letterale condiviso).
- Se mai questo progetto includesse hardware fisico commercializzato (ARALD Card/Box/Portable, oggi solo proposte documentate, nessun hardware costruito) — conformità normativa UE (RED, ETSI, CE) già segnalata come non verificata indipendentemente altrove in questa documentazione (`docs/beacon.md`), resta un punto a sé che richiede consulenza specialistica prima di una commercializzazione reale, non coperto da questa voce.
