# Guida hardware — installare un nodo Nomad-Net in un rifugio

Questo documento è pensato per **due persone diverse**, in due momenti diversi:

1. **Chi allestisce il dispositivo la prima volta** — serve un minimo di manualità (collegare cavi, inserire una scheda), ma **nessuna competenza di programmazione**. Una parte (sezione 2) richiede invece un minimo di esperienza con i computer — se non c'è nessuno disponibile, va chiesto aiuto una tantum a chi ha donato/consigliato il dispositivo, o alla comunità che segue il progetto.
2. **Chi gestisce il rifugio ogni giorno** (sezioni 3-5) — qui **non serve nessuna competenza informatica o elettronica**. Accendere, verificare che funzioni, far connettere gli ospiti: tre gesti semplici, spiegati passo passo.

> **Nota sullo stato del progetto**: quanto descritto qui riguarda la parte già pronta oggi — un nodo collegato via Wi-Fi che gli smartphone degli ospiti raggiungono con l'app mobile (pairing "come una rete Wi-Fi", nome rete + password, anche via QR — già implementato e verificato, vedi `docs/security.md` voci #23-25/#42). Il collegamento diretto via Bluetooth tra dispositivi (senza passare dal Wi-Fi del rifugio) esiste solo in versione simulata in questo momento, non su hardware radio reale — vedi `docs/deployment.md` e `docs/roadmap.md`. Questa guida non è mai stata eseguita fisicamente in un rifugio vero: è il piano di riferimento per la prima installazione reale, scritto con la stessa cura del resto della documentazione tecnica di questo repository.

---

## 1. Cosa comprare (componentistica minima)

Un solo nodo, pensato per costare poco, consumare pochissimo e non avere parti che si rompono (niente ventole, niente hard disk meccanici).

| Componente | A cosa serve | Spesa indicativa | Note per l'acquisto |
|---|---|---|---|
| **Raspberry Pi Zero 2 W** | il "cervello" del nodo: fa girare il software Nomad-Net e crea la rete Wi-Fi a cui si collegano gli ospiti | 15-20 € | Va bene anche un'alternativa equivalente (es. Orange Pi Zero) se il Raspberry non si trova; basta che abbia il Wi-Fi integrato |
| **Alimentatore con batteria tampone (UPS)**, es. una hat "PiSugar" o simile | tiene acceso il dispositivo per qualche minuto/ora se manca la corrente, evitando spegnimenti bruschi che possono rovinare la scheda di memoria | 25-35 € | Se il rifugio ha corrente stabile tutto l'anno, si può anche partire senza e aggiungerlo dopo |
| **Scheda microSD, almeno 16 GB, di tipo "industrial" o "high endurance"** (non una scheda da fotocamera qualsiasi) | è la "memoria" dove vive tutto il software | 10-15 € | Comprarne **due identiche**: una da installare, una di scorta già pronta (vedi sezione 4) |
| **Contenitore (case) passivo, senza ventola** | protegge il dispositivo da polvere e urti | 8-12 € | Meglio se con un minimo di tenuta a umidità, in un ambiente di montagna |
| **Pannello solare piccolo (5-10 W) + regolatore di carica**, *solo se non c'è una presa di corrente disponibile vicino al punto di installazione* | alimenta il dispositivo dove non arriva un cavo | 30-40 € | Non necessario se si collega a una presa già esistente nel rifugio |
| **Cavo USB corto** per l'alimentazione | collega l'alimentatore al dispositivo | 3-5 € | — |

**Spesa totale indicativa**: circa **70-110 €** collegandosi a una presa esistente, **100-150 €** con pannello solare incluso.

Dove comprare: qualunque negozio di elettronica (fisico od online) che vende materiale per hobbisti/Raspberry Pi. Non serve un negozio specializzato particolare — basta cercare i nomi dei componenti sopra.

---

## 2. Preparazione del dispositivo (una tantum — richiede un minimo di esperienza con i computer)

Questa parte va fatta **una sola volta**, prima di portare il dispositivo al rifugio, da chi ha già smanettato con un computer (anche solo installare programmi). Se non c'è nessuno disponibile, è il momento di chiedere una mano a chi ha proposto/donato il dispositivo.

1. **Scaricare "Raspberry Pi Imager"** (il programma ufficiale per preparare la scheda) su un computer qualsiasi.
2. **Scrivere sulla scheda microSD** il sistema operativo "Raspberry Pi OS Lite" (la versione senza schermo/interfaccia grafica — non serve, il dispositivo non avrà mai un monitor collegato).
3. Nelle opzioni avanzate di Raspberry Pi Imager, **configurare la rete Wi-Fi del dispositivo come punto di accesso** (access point) con:
   - un **nome rete** riconoscibile, ad esempio `NOMAD-<nome del rifugio>` (es. `NOMAD-RIFUGIO-ALPI`);
   - una **password** breve e facile da leggere ad alta voce (lo stesso stile già usato dall'app mobile del progetto — vedi `mobile/README.md` e `docs/security.md` voce #24).
4. **Copiare il software Nomad-Net** sulla scheda (la cartella `node/` di questo repository, già compilata — `npm run build -w node`) e configurarlo per **avviarsi automaticamente all'accensione** (un servizio di sistema, non un comando da digitare ogni volta).
5. **Inserire la scheda nel Raspberry Pi**, collegare l'alimentazione, aspettare 2-3 minuti e verificare che la rete Wi-Fi configurata al punto 3 compaia cercando le reti disponibili da un telefono.
6. **Stampare un'etichetta o un piccolo cartello** con su scritto, a caratteri leggibili: il nome della rete Wi-Fi, la password, e — se possibile — il codice QR di pairing generato dalla pagina web del dispositivo stesso (`GET /api/pairing`, spiegato in `docs/security.md`). Va **attaccato fisicamente sul contenitore** del dispositivo o vicino ad esso: è la cosa che il gestore del rifugio userà ogni giorno, senza dover accendere nessun computer per recuperarla.
7. **Preparare una seconda scheda identica** (copia esatta della prima) da tenere come ricambio al rifugio — vedi sezione 4.

Da qui in poi, il dispositivo è pronto e **non richiede più nessuna competenza tecnica** per essere usato.

---

## 3. Installazione fisica al rifugio

1. Scegliere un punto **al riparo da pioggia/neve diretta**, possibilmente non troppo lontano da una presa di corrente (o dal punto in cui verrà montato il pannello solare).
2. Se si usa una presa esistente: collegare l'alimentatore alla presa e il cavo USB al dispositivo.
   Se si usa il pannello solare: montarlo rivolto verso sud, senza ombre sopra (alberi, tetti sporgenti), e collegarlo secondo le istruzioni del regolatore di carica acquistato.
3. Attaccare bene il cartello/etichetta preparato al punto 6 della sezione 2, in un punto visibile agli ospiti.
4. Attendere 2-3 minuti dopo il primo collegamento: è il tempo che il dispositivo impiega ad avviarsi.
5. Fatto. Da qui in poi si passa alla gestione quotidiana (sezione 4).

---

## 4. Uso quotidiano (per chi gestisce il rifugio — nessuna competenza richiesta)

### Come si accende / spegne
Il dispositivo **resta sempre acceso**, come un router Wi-Fi di casa: non c'è un interruttore da premere ogni giorno. Va scollegato dalla corrente solo se serve davvero spostarlo o se qualcuno lo richiede esplicitamente per manutenzione (sezione 5).

### Come sapere se funziona
- Il Raspberry Pi ha una piccola luce (LED) che resta accesa/lampeggia quando il dispositivo è acceso e sta lavorando. Se la luce è **spenta**, il dispositivo non ha corrente — controllare che il cavo sia ben collegato (o che il pannello solare stia caricando, se è l'unica fonte).
- Il modo più affidabile per sapere se funziona davvero è **provare a collegarsi**: cercare la rete Wi-Fi indicata sul cartello da un telefono. Se compare, il dispositivo è vivo.

### Come far connettere gli ospiti
1. L'ospite apre le impostazioni Wi-Fi del proprio telefono (esattamente come farebbe per collegarsi a una qualunque rete Wi-Fi).
2. Cerca il nome rete scritto sul cartello (es. `NOMAD-RIFUGIO-ALPI`) e inserisce la password indicata.
3. Se ha installato l'app Nomad-Net, può anche **inquadrare il QR code** sul cartello invece di digitare nome e password a mano.
4. Una volta collegato, l'ospite può usare l'app (o la pagina web che il dispositivo mostra automaticamente) per vedere contenuti, servizi e messaggi disponibili — senza bisogno di alcuna connessione a Internet.

### Cosa NON fare
- **Non scollegare bruscamente** la corrente se non è necessario: se possibile, meglio aspettare un momento di calma (poche persone collegate) prima di staccare il cavo per manutenzione — un'interruzione improvvisa, ripetuta nel tempo, può rovinare la scheda di memoria.
- **Non aprire il contenitore** per curiosità: non c'è nulla da regolare all'interno, e la polvere/umidità che entra può danneggiare i componenti.
- **Non serve mai** installare aggiornamenti, digitare comandi o collegare tastiere/monitor: il dispositivo è pensato per funzionare da solo.

---

## 5. Manutenzione periodica (poche volte l'anno)

Anche qui, gesti semplici — non serve competenza tecnica, solo un minimo di attenzione periodica:

- **Pulizia**: una volta ogni tanto, controllare che non ci sia polvere/ragnatele accumulata sul contenitore o (se presente) sul pannello solare — basta un panno asciutto.
- **Pannello solare** (se presente): controllare che non sia coperto da neve, foglie o sporco che ne riducono la resa, soprattutto dopo temporali o nevicate.
- **Batteria tampone / power bank**: le batterie si esauriscono nel tempo (in genere dopo qualche anno di uso continuo) — se il dispositivo comincia a spegnersi non appena manca la corrente principale, è probabile che vada sostituita. Non è un'emergenza: il dispositivo torna a funzionare normalmente appena la corrente torna.
- **Scheda di ricambio**: se il dispositivo smette di funzionare e non si riaccende nemmeno ricollegando bene l'alimentazione, si può provare a **sostituire la scheda microSD** con quella di ricambio preparata alla sezione 2 (si estrae quella vecchia, si inserisce quella nuova, si ricollega la corrente). Se questo passaggio mette a disagio, meglio comunque chiedere aiuto piuttosto che forzare qualcosa.
- **Backup periodico**: chi ha preparato il dispositivo (sezione 2) dovrebbe, una volta ogni tanto, fare una copia aggiornata della scheda microSD — non è un compito per il gestore del rifugio.

---

## 6. Problemi comuni e a chi rivolgersi

| Cosa si osserva | Cosa provare | Se non si risolve |
|---|---|---|
| Nessuna luce accesa sul dispositivo | Controllare che il cavo di alimentazione sia ben inserito da entrambi i lati | Contattare chi ha installato il dispositivo |
| La rete Wi-Fi non compare cercandola dal telefono | Aspettare 2-3 minuti (il dispositivo può essersi appena riacceso), poi riprovare | Provare a scollegare e ricollegare la corrente una volta, aspettando di nuovo qualche minuto; se non basta, contattare chi ha installato il dispositivo |
| Il telefono si collega alla rete ma l'app/pagina web non si apre | Verificare di essere abbastanza vicini al dispositivo (il segnale Wi-Fi ha un raggio limitato) | Contattare chi ha installato il dispositivo |
| Il dispositivo si spegne spesso quando manca la corrente | Probabile batteria tampone da sostituire (sezione 5) | Segnalarlo a chi ha installato il dispositivo, così può portare/ordinare una batteria nuova |

**Contatto di riferimento per problemi persistenti**: da compilare con il nominativo/recapito di chi ha installato il dispositivo (sezione 2) o della persona/associazione che segue il progetto Nomad-Net per questo rifugio — questa guida non può includere un contatto specifico, va aggiunto a mano sul cartello o su questa pagina prima della distribuzione.
