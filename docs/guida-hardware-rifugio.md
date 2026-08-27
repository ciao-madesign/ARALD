# Guida hardware — installare un nodo Nomad-Net in un rifugio

Questo documento è pensato per **due persone diverse**, in due momenti diversi:

1. **Chi allestisce il dispositivo la prima volta** — serve un minimo di manualità (collegare cavi, inserire una scheda), ma **nessuna competenza di programmazione**. Una parte (sezione 2) richiede invece un minimo di esperienza con i computer — se non c'è nessuno disponibile, va chiesto aiuto una tantum a chi ha donato/consigliato il dispositivo, o alla comunità che segue il progetto.
2. **Il rifugista** (chi gestisce il rifugio ogni giorno, sezioni 3-5) — qui **non serve nessuna competenza informatica o elettronica**. Accendere, verificare che funzioni, far connettere gli ospiti: tre gesti semplici, spiegati passo passo.

> **Nota sullo stato del progetto**: quanto descritto qui riguarda la parte già pronta oggi — un nodo collegato via Wi-Fi che gli smartphone degli ospiti raggiungono con l'app mobile (pairing "come una rete Wi-Fi", nome rete + password, anche via QR — già implementato e verificato, vedi `docs/security.md` voci #23-25/#42). Il collegamento diretto via Bluetooth tra dispositivi (senza passare dal Wi-Fi del rifugio) esiste solo in versione simulata in questo momento, non su hardware radio reale — vedi `docs/deployment.md` e `docs/roadmap.md`. Questa guida non è mai stata eseguita fisicamente in un rifugio vero: è il piano di riferimento per la prima installazione reale, scritto con la stessa cura del resto della documentazione tecnica di questo repository.

---

## 1. Cosa comprare (componentistica minima)

Un solo nodo, pensato per costare poco, consumare pochissimo e non avere parti che si rompono (niente ventole, niente hard disk meccanici). Ci sono **due strade equivalenti** per il "cervello" del nodo — scegline una, il resto della guida (sezioni 3-6) non cambia.

**Quale scegliere**: l'**Opzione A (router Wi-Fi con OpenWrt)** è oggi la scelta consigliata — è pensata di fabbrica per fare esattamente il lavoro che serve qui (creare una rete Wi-Fi e instradare traffico), quindi il punto di accesso e l'apertura automatica del browser (sezione 2) si configurano dall'interfaccia web del router invece che scrivendo a mano i file `hostapd.conf`/`dnsmasq.conf`, ed è più facile da trovare (non soggetta alla stessa carenza di mercato del Raspberry Pi). L'**Opzione B (scheda singola tipo Raspberry Pi)** resta comunque valida — meglio se chi allestisce il dispositivo ha già esperienza con Raspberry Pi/Linux da SBC ("single-board computer") e preferisce quel percorso, oppure se nessun router dell'elenco sotto si trova a un prezzo ragionevole.

### Opzione A — Router Wi-Fi con OpenWrt (consigliata)

**Quale modello comprare**: serve un router che abbia OpenWrt **già preinstallato di fabbrica** (non un router generico a cui installarlo da soli, passaggio più delicato e non necessario) — la gamma **GL.iNet** è oggi la scelta più semplice per questo, perché ogni modello lo ha già pronto con un'interfaccia web guidata.

**Requisito che conta più di RAM/flash dichiarate: il chip deve essere ARM, non MIPS/Atheros più vecchio.** I core MIPS 24Kc usati nei modelli GL.iNet più economici (es. MediaTek MT7628 del "Mango", Qualcomm Atheros QCA9563 dello "Slate"/AR750S) **non hanno un'unità floating-point (FPU) hardware** — Node.js (il motore V8) genera istruzioni in virgola mobile e **non funziona senza FPU hardware**, un'incompatibilità nota e documentata, non solo "prestazioni scarse". Esiste in teoria un workaround (ricompilare il kernel con emulazione software della FPU), ma è lento e richiede compilare firmware custom — non adatto a questa guida. I modelli con chip **MediaTek "Filogic"** (MT7981/MT7986, entrambi ARM Cortex-A53) **non hanno questo problema** — è il criterio di scelta più importante, prima ancora del prezzo. Modelli consigliati (specifiche verificate, prezzi indicativi da verificare al momento dell'acquisto):

| Modello | Chip / RAM / memoria | Prezzo indicativo | Quando sceglierlo |
|---|---|---|---|
| **GL.iNet GL-MT3000 "Beryl AX"** | MediaTek MT7981 (ARM Cortex-A53), 512 MB RAM, 256 MB flash, porta USB 3.0 per spazio extra | 50-65 € | **Scelta di riferimento per questo progetto** — RAM/flash abbondanti per far girare Nomad-Net senza problemi, consumo bassissimo (2,6-5 W, ottimo con pannello solare), formato tascabile |
| **GL.iNet GL-MT6000 "Flint 2"** | MediaTek MT7986 (ARM Cortex-A53), 1 GB RAM, 8 GB di memoria interna eMMC (non solo flash) | 130-150 € | Se il budget lo permette e si vuole margine per il futuro (più dispositivi collegati, più contenuti in cache) — più grande e con un consumo un po' più alto (router "da tavolo", non tascabile), ma zero pensieri di spazio |

**Da evitare per questo progetto, indipendentemente dal prezzo**: qualunque modello GL.iNet basato su chip MIPS/Atheros più vecchio — non solo il "Mango" (MediaTek MT7628, 128 MB RAM/16 MB flash) ma anche lo **"Slate"/GL-AR750S** (Qualcomm Atheros QCA9563), inizialmente indicato in una versione precedente di questa guida come ripiego economico e poi scartato dopo aver verificato che monta lo stesso core MIPS 24Kc senza FPU — l'incompatibilità con Node.js è la stessa del Mango, non solo "poca memoria". Prima di comprare un modello diverso da quelli in tabella, verificarne il chip (pagina prodotto GL.iNet o [OpenWrt Table of Hardware](https://openwrt.org/toh/start)) e assicurarsi che sia una famiglia ARM (Cortex-A53 o superiore), non MIPS.

| Componente | A cosa serve | Spesa indicativa | Note per l'acquisto |
|---|---|---|---|
| **Router Wi-Fi con OpenWrt preinstallato** (uno dei modelli consigliati sopra) | il "cervello" del nodo: fa girare il software Nomad-Net **e** crea già di suo la rete Wi-Fi a cui si collegano gli ospiti — nessun passo di configurazione separato per il punto di accesso | vedi tabella sopra | Va scelto un modello con **almeno 256 MB di RAM e una porta USB** per lo spazio extra (il software Nomad-Net più le sue dipendenze non entrano comodamente nella sola memoria flash interna dei modelli più economici) |
| **Chiavetta USB, almeno 8 GB** (solo se il router scelto ha poca memoria flash interna) | spazio extra dove installare il software Nomad-Net e le sue dipendenze, oltre al piccolo spazio di fabbrica del router | 5-10 € | Non serve se il router ha già memoria interna abbondante (es. eMMC) — verificare le specifiche del modello scelto |
| **Alimentatore USB-C originale o di buona qualità** (quasi tutti i router di questo tipo si alimentano da USB-C, come un telefono) | alimenta il router | incluso di solito nella confezione | Se manca, va bene un buon alimentatore USB-C da telefono (5V, almeno 2A) |
| **Power bank USB-C con passthrough** (si carica e alimenta il dispositivo contemporaneamente), *al posto di un vero UPS* | stessa funzione della batteria tampone dell'Opzione B: tiene acceso il router per un po' se manca la corrente | 20-30 € | Facoltativo se il rifugio ha corrente stabile tutto l'anno |
| **Pannello solare piccolo (5-10 W) + regolatore di carica USB**, *solo se non c'è una presa di corrente vicino al punto di installazione* | alimenta il dispositivo dove non arriva un cavo | 30-40 € | Non necessario se si collega a una presa già esistente |

**Spesa totale indicativa**: circa **60-80 €** con il GL-MT3000 "Beryl AX" consigliato (collegandosi a una presa esistente), **90-120 €** con pannello solare incluso — più alta con il GL-MT6000 "Flint 2" (vedi tabella sopra).

### Opzione B — Scheda singola (SBC), es. Raspberry Pi

| Componente | A cosa serve | Spesa indicativa | Note per l'acquisto |
|---|---|---|---|
| **Raspberry Pi Zero 2 W** | il "cervello" del nodo: fa girare il software Nomad-Net e crea la rete Wi-Fi a cui si collegano gli ospiti | 15-20 € | Va bene anche un'alternativa equivalente (es. Orange Pi Zero 2W/3, più facile da trovare del Raspberry in questo periodo) se il Raspberry non si trova; basta che abbia il Wi-Fi integrato |
| **Alimentatore con batteria tampone (UPS)**, es. una hat "PiSugar" o simile | tiene acceso il dispositivo per qualche minuto/ora se manca la corrente, evitando spegnimenti bruschi che possono rovinare la scheda di memoria | 25-35 € | Se il rifugio ha corrente stabile tutto l'anno, si può anche partire senza e aggiungerlo dopo |
| **Scheda microSD, almeno 16 GB, di tipo "industrial" o "high endurance"** (non una scheda da fotocamera qualsiasi) | è la "memoria" dove vive tutto il software | 10-15 € | Comprarne **due identiche**: una da installare, una di scorta già pronta (vedi sezione 4) |
| **Contenitore (case) passivo, senza ventola** | protegge il dispositivo da polvere e urti | 8-12 € | Meglio se con un minimo di tenuta a umidità, in un ambiente di montagna |
| **Pannello solare piccolo (5-10 W) + regolatore di carica**, *solo se non c'è una presa di corrente disponibile vicino al punto di installazione* | alimenta il dispositivo dove non arriva un cavo | 30-40 € | Non necessario se si collega a una presa già esistente nel rifugio |
| **Cavo USB corto** per l'alimentazione | collega l'alimentatore al dispositivo | 3-5 € | — |

**Spesa totale indicativa**: circa **70-110 €** collegandosi a una presa esistente, **100-150 €** con pannello solare incluso.

Dove comprare: qualunque negozio di elettronica (fisico od online) che vende materiale per hobbisti/reti — per l'Opzione A, anche direttamente dal produttore del router scelto (es. lo store ufficiale GL.iNet); per l'Opzione B, un negozio che vende materiale per hobbisti/Raspberry Pi. Non serve un negozio specializzato particolare.

---

## 2. Preparazione del dispositivo (una tantum — richiede un minimo di esperienza con i computer)

Questa parte va fatta **una sola volta**, prima di portare il dispositivo al rifugio, da chi ha già smanettato con un computer (anche solo installare programmi). Se non c'è nessuno disponibile, è il momento di chiedere una mano a chi ha proposto/donato il dispositivo. Segui la sottosezione corrispondente a cosa hai comprato alla sezione 1 (2A per il router OpenWrt, 2B per la scheda singola/Raspberry Pi) — non servono entrambe.

### 2A — Router Wi-Fi con OpenWrt

Il vantaggio di partire da un router con OpenWrt già preinstallato è che il punto di accesso Wi-Fi (nome rete, password) e spesso anche l'apertura automatica del browser sono **già pronti di fabbrica o configurabili dalla pagina web del router stesso** — non serve scrivere a mano i file di configurazione descritti nell'Opzione B qui sotto.

1. **Accendere il router e collegarsi alla sua pagina di amministrazione** (via cavo o Wi-Fi, seguendo le istruzioni del modello scelto — di solito un indirizzo tipo `192.168.8.1` aperto dal browser di un computer).
2. **Rinominare la rete Wi-Fi** (SSID) e impostare una **password** breve e facile da leggere ad alta voce (lo stesso stile già usato dall'app mobile del progetto — vedi `mobile/README.md` e `docs/security.md` voce #24), es. nome rete `NOMAD-<nome del rifugio>`.
3. **Passo facoltativo ma consigliato — apertura automatica del browser**: quasi tutti i router basati su OpenWrt permettono di impostare, dalla stessa pagina di amministrazione (sezione DHCP/DNS, spesso chiamata "dnsmasq" anche nell'interfaccia grafica), una regola che fa rispondere il DNS del router con il proprio indirizzo per **qualunque** dominio richiesto — lo stesso effetto ottenuto manualmente con `address=/#/<indirizzo router>` nell'Opzione B qui sotto, ma senza dover collegarsi da riga di comando. Se l'interfaccia grafica del modello scelto non espone questa opzione, si può comunque modificare lo stesso file `/etc/dnsmasq.conf` di OpenWrt via SSH, identico nella sostanza a quanto descritto nell'Opzione B. Chi non ha esperienza con questo passo può saltarlo: senza, l'ospite dovrà aprire l'app o il browser da sé invece che vederselo aprire in automatico — il metodo con QR/nome rete e password resta sempre disponibile.
4. **Installare Node.js sul router** — dalla pagina di amministrazione (se il modello scelto ha una sezione "Gestione pacchetti"/"App") o via SSH con `opkg update && opkg install node`. Se il router ha poca memoria flash interna, collegare prima la chiavetta USB della sezione 1 e configurarla come spazio extra ("extroot", spiegato nella documentazione del modello) prima di installare qualunque pacchetto.
5. **Copiare il software Nomad-Net** sul router (la cartella `node/` di questo repository, già compilata — `npm run build -w node`) e configurarlo per **avviarsi automaticamente all'accensione** — su OpenWrt, uno script di avvio in `/etc/init.d/` gestito da `procd` (il sistema di avvio automatico dei servizi), non un comando da digitare ogni volta.
6. **Riavviare il router** e verificare che la rete Wi-Fi configurata al punto 2 compaia cercando le reti disponibili da un telefono.
7. **Stampare un'etichetta o un piccolo cartello** con su scritto, a caratteri leggibili: il nome della rete Wi-Fi, la password, e — se possibile — il codice QR di pairing generato dalla pagina web del dispositivo stesso (`GET /api/pairing`, spiegato in `docs/security.md`). Va **attaccato fisicamente sul router** o vicino ad esso: è la cosa che il rifugista userà ogni giorno, senza dover accendere nessun computer per recuperarla.
8. **Fare un backup della configurazione del router** (quasi ogni pagina di amministrazione OpenWrt ha un pulsante "Backup"/"Esporta configurazione") e salvarlo su un computer — è l'equivalente della "seconda scheda di ricambio" dell'Opzione B: se il router va ripristinato ai valori di fabbrica, la configurazione si può ricaricare in pochi minuti invece di rifare tutti i passi sopra.

Da qui in poi, il dispositivo è pronto e **non richiede più nessuna competenza tecnica** per essere usato — salta la sezione 2B e vai alla sezione 3.

---

### 2B — Scheda singola (SBC), es. Raspberry Pi

1. **Scaricare "Raspberry Pi Imager"** (il programma ufficiale per preparare la scheda) su un computer qualsiasi.
2. **Scrivere sulla scheda microSD** il sistema operativo "Raspberry Pi OS Lite" (la versione senza schermo/interfaccia grafica — non serve, il dispositivo non avrà mai un monitor collegato).
3. Nelle opzioni avanzate di Raspberry Pi Imager, **configurare la rete Wi-Fi del dispositivo come punto di accesso** (access point) con:
   - un **nome rete** riconoscibile, ad esempio `NOMAD-<nome del rifugio>` (es. `NOMAD-RIFUGIO-ALPI`);
   - una **password** breve e facile da leggere ad alta voce (lo stesso stile già usato dall'app mobile del progetto — vedi `mobile/README.md` e `docs/security.md` voce #24).

   **Passo facoltativo ma consigliato — apertura automatica del browser**: di norma, dopo essersi collegati alla rete Wi-Fi, un ospite deve aprire da sé l'app o il browser per raggiungere il dispositivo. Configurando anche il DNS del punto di accesso perché risponda con l'indirizzo del dispositivo stesso a **qualunque** nome a dominio richiesto (non solo il proprio), il telefono dell'ospite — per come iOS, Android, Windows e la maggior parte dei browser sono già fatti — **apre da solo un popup "Accedi alla rete"** puntato sulla pagina del dispositivo, esattamente come succede già oggi collegandosi al Wi-Fi di un hotel o di un aeroporto. Il software Nomad-Net (`node/src/web-ui.ts`) riconosce già le richieste che iOS/Android/Windows/Firefox mandano automaticamente per decidere se mostrare quel popup, e risponde in modo da farlo comparire puntato sulla home page — questa parte è già pronta e testata in automatico (vedi `docs/security.md`), **manca solo la configurazione di rete** che segue, che va fatta con `hostapd` (il punto di accesso Wi-Fi vero e proprio) e `dnsmasq` (il server DNS/DHCP che fa "credere" a ogni telefono di dover raggiungere il dispositivo per qualunque sito):

   ```
   # /etc/hostapd/hostapd.conf — il punto di accesso Wi-Fi
   interface=wlan0
   driver=nl80211
   ssid=NOMAD-RIFUGIO-ALPI
   hw_mode=g
   channel=7
   wpa=2
   wpa_passphrase=K7XM2QRT
   wpa_key_mgmt=WPA-PSK
   rsn_pairwise=CCMP
   ```

   ```
   # /etc/dnsmasq.conf — DHCP (assegna un indirizzo ad ogni telefono) + DNS (fa "credere" che ogni
   # sito sia il dispositivo stesso, indispensabile per far comparire il popup automatico sopra)
   interface=wlan0
   dhcp-range=192.168.4.2,192.168.4.100,255.255.255.0,24h
   address=/#/192.168.4.1
   ```

   L'indirizzo `192.168.4.1` è quello che il dispositivo stesso assume sulla propria interfaccia Wi-Fi (`wlan0`) quando fa da punto di accesso — va assegnato allo stesso modo nella configurazione di rete del sistema operativo (fuori dai due file sopra, con `dhcpcd`/`NetworkManager` a seconda della versione di Raspberry Pi OS). Chi non ha esperienza con questi due file può comunque saltare questo passo facoltativo: senza, tutto il resto della guida funziona identico, l'unica differenza è che l'ospite dovrà aprire l'app o il browser da sé invece che vederselo aprire in automatico — il metodo con QR/nome rete e password resta sempre disponibile.
4. **Copiare il software Nomad-Net** sulla scheda (la cartella `node/` di questo repository, già compilata — `npm run build -w node`) e configurarlo per **avviarsi automaticamente all'accensione** (un servizio di sistema, non un comando da digitare ogni volta).
5. **Inserire la scheda nel Raspberry Pi**, collegare l'alimentazione, aspettare 2-3 minuti e verificare che la rete Wi-Fi configurata al punto 3 compaia cercando le reti disponibili da un telefono.
6. **Stampare un'etichetta o un piccolo cartello** con su scritto, a caratteri leggibili: il nome della rete Wi-Fi, la password, e — se possibile — il codice QR di pairing generato dalla pagina web del dispositivo stesso (`GET /api/pairing`, spiegato in `docs/security.md`). Va **attaccato fisicamente sul contenitore** del dispositivo o vicino ad esso: è la cosa che il rifugista userà ogni giorno, senza dover accendere nessun computer per recuperarla.
7. **Preparare una seconda scheda identica** (copia esatta della prima) da tenere come ricambio al rifugio — vedi sezione 4.

Da qui in poi, il dispositivo è pronto e **non richiede più nessuna competenza tecnica** per essere usato.

---

## 3. Installazione fisica al rifugio

1. Scegliere un punto **al riparo da pioggia/neve diretta**, possibilmente non troppo lontano da una presa di corrente (o dal punto in cui verrà montato il pannello solare).
2. Se si usa una presa esistente: collegare l'alimentatore alla presa e il cavo USB al dispositivo.
   Se si usa il pannello solare: montarlo rivolto verso sud, senza ombre sopra (alberi, tetti sporgenti), e collegarlo secondo le istruzioni del regolatore di carica acquistato.
3. Attaccare bene il cartello/etichetta preparato al passo dedicato della sezione 2A o 2B (a seconda del percorso scelto), in un punto visibile agli ospiti.
4. Attendere 2-3 minuti dopo il primo collegamento: è il tempo che il dispositivo impiega ad avviarsi.
5. Fatto. Da qui in poi si passa alla gestione quotidiana (sezione 4).

---

## 4. Uso quotidiano (per il rifugista — nessuna competenza richiesta)

### Come si accende / spegne
Il dispositivo **resta sempre acceso**, come un router Wi-Fi di casa: non c'è un interruttore da premere ogni giorno. Va scollegato dalla corrente solo se serve davvero spostarlo o se qualcuno lo richiede esplicitamente per manutenzione (sezione 5).

### Come sapere se funziona
- Quasi ogni dispositivo (router o scheda singola) ha una piccola luce (LED) che resta accesa/lampeggia quando è acceso e sta lavorando. Se la luce è **spenta**, il dispositivo non ha corrente — controllare che il cavo sia ben collegato (o che il pannello solare stia caricando, se è l'unica fonte).
- Il modo più affidabile per sapere se funziona davvero è **provare a collegarsi**: cercare la rete Wi-Fi indicata sul cartello da un telefono. Se compare, il dispositivo è vivo.

### Come far connettere gli ospiti
1. L'ospite apre le impostazioni Wi-Fi del proprio telefono (esattamente come farebbe per collegarsi a una qualunque rete Wi-Fi).
2. Cerca il nome rete scritto sul cartello (es. `NOMAD-RIFUGIO-ALPI`) e inserisce la password indicata.
3. Se ha installato l'app Nomad-Net, può anche **inquadrare il QR code** sul cartello invece di digitare nome e password a mano.
4. Se il dispositivo è stato configurato con il passo facoltativo della sezione 2A o 2B ("apertura automatica del browser"), spesso **non serve nemmeno il passo 3**: appena il telefono si collega, si apre da solo un popup con la pagina del dispositivo — esattamente come collegandosi al Wi-Fi di un hotel. Non è garantito su ogni telefono/versione di sistema operativo, quindi il metodo manuale (passo 2-3) resta sempre disponibile come alternativa.
5. Una volta collegato, l'ospite può usare l'app (o la pagina web che il dispositivo mostra) per vedere contenuti, servizi e messaggi disponibili — senza bisogno di alcuna connessione a Internet.

### Cosa NON fare
- **Non scollegare bruscamente** la corrente se non è necessario: se possibile, meglio aspettare un momento di calma (poche persone collegate) prima di staccare il cavo per manutenzione — un'interruzione improvvisa, ripetuta nel tempo, può rovinare la memoria interna del dispositivo (la scheda microSD per l'Opzione B, la memoria flash/eMMC per l'Opzione A).
- **Non aprire il contenitore** per curiosità: non c'è nulla da regolare all'interno, e la polvere/umidità che entra può danneggiare i componenti.
- **Non serve mai** installare aggiornamenti, digitare comandi o collegare tastiere/monitor: il dispositivo è pensato per funzionare da solo.

---

## 5. Manutenzione periodica (poche volte l'anno)

Anche qui, gesti semplici — non serve competenza tecnica, solo un minimo di attenzione periodica:

- **Pulizia**: una volta ogni tanto, controllare che non ci sia polvere/ragnatele accumulata sul contenitore o (se presente) sul pannello solare — basta un panno asciutto.
- **Pannello solare** (se presente): controllare che non sia coperto da neve, foglie o sporco che ne riducono la resa, soprattutto dopo temporali o nevicate.
- **Batteria tampone / power bank**: le batterie si esauriscono nel tempo (in genere dopo qualche anno di uso continuo) — se il dispositivo comincia a spegnersi non appena manca la corrente principale, è probabile che vada sostituita. Non è un'emergenza: il dispositivo torna a funzionare normalmente appena la corrente torna.
- **Ripristino in caso di guasto** — dipende dall'opzione scelta alla sezione 1:
  - **Opzione B (scheda singola)**: se il dispositivo smette di funzionare e non si riaccende nemmeno ricollegando bene l'alimentazione, si può provare a **sostituire la scheda microSD** con quella di ricambio preparata alla sezione 2B (si estrae quella vecchia, si inserisce quella nuova, si ricollega la corrente).
  - **Opzione A (router OpenWrt)**: se il router smette di funzionare correttamente, si può provare un riavvio (scollegare/ricollegare l'alimentazione); se non basta, un ripristino ai valori di fabbrica seguito dal ricaricamento del backup di configurazione salvato alla sezione 2A riporta il dispositivo operativo in pochi minuti.

  In entrambi i casi, se il passaggio mette a disagio, meglio chiedere aiuto piuttosto che forzare qualcosa.
- **Backup periodico**: chi ha preparato il dispositivo (sezione 2) dovrebbe, una volta ogni tanto, fare una copia aggiornata della scheda microSD (Opzione B) o del file di configurazione del router (Opzione A) — non è un compito per il rifugista.

---

## 6. Problemi comuni e a chi rivolgersi

| Cosa si osserva | Cosa provare | Se non si risolve |
|---|---|---|
| Nessuna luce accesa sul dispositivo | Controllare che il cavo di alimentazione sia ben inserito da entrambi i lati | Contattare chi ha installato il dispositivo |
| La rete Wi-Fi non compare cercandola dal telefono | Aspettare 2-3 minuti (il dispositivo può essersi appena riacceso), poi riprovare | Provare a scollegare e ricollegare la corrente una volta, aspettando di nuovo qualche minuto; se non basta, contattare chi ha installato il dispositivo |
| Il telefono si collega alla rete ma l'app/pagina web non si apre | Verificare di essere abbastanza vicini al dispositivo (il segnale Wi-Fi ha un raggio limitato) | Contattare chi ha installato il dispositivo |
| Il dispositivo si spegne spesso quando manca la corrente | Probabile batteria tampone da sostituire (sezione 5) | Segnalarlo a chi ha installato il dispositivo, così può portare/ordinare una batteria nuova |

**Contatto di riferimento per problemi persistenti**: da compilare con il nominativo/recapito di chi ha installato il dispositivo (sezione 2) o della persona/associazione che segue il progetto Nomad-Net per questo rifugio — questa guida non può includere un contatto specifico, va aggiunto a mano sul cartello o su questa pagina prima della distribuzione.
