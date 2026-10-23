# Come riaccendere/spegnere il prototipo ARALD Box (Orange Pi 4 Pro)

Questa guida serve per il **prototipo attuale**, non per un dispositivo finale pronto per un rifugio (quello è descritto in [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md), che non richiede mai di digitare comandi).

**Aggiornamento 28 settembre 2026 — persistenza attiva + solo Wi-Fi**: il software ARALD parte **da solo** all'accensione della scheda, come servizio di sistema (`systemd`, unità `arald-box.service`) — non serve collegarsi via SSH e lanciare un comando ogni volta. La scheda è ora collegata **solo via Wi-Fi**, nessun cavo Ethernet, con un indirizzo IP **fisso** impostato direttamente sulla scheda (non più assegnato dinamicamente via DHCP).

**Dati del dispositivo** (da aggiornare se cambiano):
- Utente: `orangepi`
- Indirizzo di rete: `192.168.1.50` (Wi-Fi, fisso — impostato sulla scheda per evitare la collisione avuta in precedenza con un altro dispositivo sulla rete che usava `192.168.1.8`/`.9`)
- Rete Wi-Fi: `Eolo_4a9b2c`

**Nota su "fisso"**: l'indirizzo è configurato staticamente sulla scheda stessa, non prenotato sul router — evita collisioni con quel dispositivo specifico, ma in teoria il router potrebbe ancora assegnare lo stesso indirizzo a un altro dispositivo in futuro via DHCP. Per un'esclusione garantita servirebbe una prenotazione DHCP sul router (basata sul MAC address della scheda) — non ancora fatta, candidato per dopo se dovesse ripresentarsi un conflitto.

## Per accenderlo

1. Ricollega l'alimentazione alla scheda (nessun cavo di rete necessario).
2. Aspetta 2-3 minuti: è il tempo che impiega ad avviare Linux, collegarsi al Wi-Fi **e** far partire da solo il software ARALD.
3. Fatto — nessun altro passo necessario. Verifica con la sezione sotto.

## Per verificare che funzioni

Da un altro dispositivo sulla stessa rete Wi-Fi (telefono, altro computer), apri nel browser:
```
http://192.168.1.50:8080
```
Se la pagina si carica e mostra lo stato del nodo, tutto ok — non serve nessuna sessione SSH aperta.

## Per spegnerlo in sicurezza

Il software si ferma da solo quando il sistema operativo si spegne (il servizio è gestito da `systemd`, si arresta in modo ordinato insieme al resto del sistema) — non serve fermarlo a mano prima.

1. Collegati via SSH: `ssh orangepi@192.168.1.50` (password richiesta).
2. Spegni il sistema operativo della scheda:
   ```
   sudo shutdown -h now
   ```
3. Aspetta che il LED della scheda smetta di lampeggiare (segno che è davvero spenta) — **non scollegare l'alimentazione prima**, rischia di danneggiare la scheda di memoria.
4. Solo a quel punto scollega l'alimentazione (unica connessione fisica rimasta, oltre alla microSD).

## Comandi utili per il servizio (via SSH, solo se serve intervenire)

- Vedere se è attivo: `sudo systemctl status arald-box.service`
- Fermarlo senza spegnere la scheda: `sudo systemctl stop arald-box.service`
- Riavviarlo (es. dopo un aggiornamento del codice): `sudo systemctl restart arald-box.service`
- Vedere i log recenti: `journalctl -u arald-box.service -f` (Ctrl+C per uscire)

**Dopo aver aggiornato il codice** (`git pull` + `npm run build -w node` dentro `~/ARALD`), il servizio non ricarica da solo la nuova build — serve un `sudo systemctl restart arald-box.service` per far ripartire il nodo con le modifiche.

## Comandi utili per la rete Wi-Fi (via SSH, solo se serve intervenire)

- Vedere lo stato delle interfacce di rete: `nmcli device status`
- Vedere i dettagli della connessione Wi-Fi (IP, gateway, DNS): `nmcli device show wlan0`
- Vedere/modificare la configurazione salvata: `nmcli connection show` / `sudo nmcli connection modify "Eolo_4a9b2c" ...`

## Se qualcosa non torna

- **`192.168.1.50` non risponde più**: verificare che il Wi-Fi di casa sia acceso e raggiungibile normalmente da altri dispositivi. Essendo un indirizzo fisso (non DHCP), non dovrebbe più cambiare da solo — se non risponde, il sospetto più probabile è che la scheda sia spenta o abbia perso la connessione Wi-Fi, non che l'indirizzo sia cambiato.
- **SSH avvisa "host key has changed" o "can't be established"**: capitato durante la configurazione iniziale (documentato per riferimento) — quasi sempre legato a un cambio di indirizzo IP altrove sulla rete, non un problema di sicurezza reale su una rete domestica nota. Sul Mac: `ssh-keygen -R <IP in questione>` rimuove solo la voce obsoleta (nessun effetto su altri dispositivi della rete), poi si riprova la connessione — se il messaggio è "can't be established" (prima connessione a un indirizzo mai visto), basta confermare con `yes`.
- **Password dimenticata/da cambiare**: la password dell'utente `orangepi` può essere quella di default — per cambiarla, una volta collegati via SSH: `passwd`.

## Identità persistente (`--identity-dir`) — fatto il 23 ottobre 2026

**Scoperto il 28 settembre 2026**: il Node ID del Box cambiava a ogni riavvio del servizio, perché il comando non passava `--identity-dir`. **Risolto il 23 ottobre 2026**, ma con un'avvertenza utile da ricordare: la prima volta il flag era scritto con uno spazio di troppo (`-- identity-dir`) e il nodo lo ignorava **senza alcun errore**; in più la build che girava sul Box era vecchia e non conosceva proprio quel flag (`docs/security.md` voce #146). Il modo giusto di controllare è la riga di avvio, non fidarsi della configurazione:
```bash
journalctl -u arald-box.service -n 30 --no-pager | grep -E "Node ID|Identity"
```
Deve comparire `Identity persisted in: /home/orangepi/.arald-identity (same Node ID across restarts)`. Se compare `Identity: ephemeral, regenerated on every restart`, il flag non è arrivato al programma. Dopo un secondo `sudo systemctl restart arald-box.service` il Node ID deve restare identico.

**Riga `ExecStart` corretta**, tutta su una riga, con la password tra virgolette e **senza spazio dopo `--`** (la password qui sotto è un segnaposto, non quella vera):
```
ExecStart=/usr/bin/node dist/cli.js --id BOX1 --port 9001 --web-port 8080 --web-host 0.0.0.0 --register-as-relay-registry --expose-relay-registry --network-password "<password>" --allow-service-calls --identity-dir /home/orangepi/.arald-identity
```
Dopo ogni modifica al file: `sudo systemctl daemon-reload` e poi `sudo systemctl restart arald-box.service`. `--expose-emergency-beacons true` è stato aggiunto solo per le prove del 23 ottobre (serve a leggere gli SOS ricevuti): non va lasciato su un Box consegnato.

## Aggiornare il codice sul Box — nota del 23 ottobre 2026

La copia di `~/ARALD` sul Box **non si aggiorna da sola** e quel giorno aveva quasi un mese di ritardo: l'app mobile sul Box non aveva ancora il canale "SOS via gateway" (dal 1 ottobre) e dava "Bluetooth non disponibile" a ogni browser. Per aggiornare (e **riavviare**: il servizio esegue la build `dist/`, non i sorgenti):
```bash
cd ~/ARALD && git status --short      # niente modifiche locali sospette prima del pull
git pull && npm install && npm run build -w node
sudo systemctl restart arald-box.service
git log --oneline -1                  # conferma che il pull è avvenuto
```

## Provare l'app mobile da un telefono (procedura di test, non per l'uso normale) — 23 ottobre 2026

Un telefono che apre `mobile/www/` da una pagina HTTP non può usare la posizione (il browser la blocca fuori da un contesto sicuro) e senza posizione non si pubblica un drop. Per una **prova** (provata con un iPhone, Chrome per iOS) servono: un certificato self-signed, l'app servita in HTTPS e il nodo raggiungibile in HTTPS (una pagina HTTPS non può chiamare un indirizzo HTTP). Tutto va spento a fine prova. Non è la configurazione di un Box consegnato: lì l'utente non deve mai fare nulla di questo (vedi `docs/security.md` voce #146, "Come dovrà essere a regime").

1. **Certificato** (nella cartella `mobile/www/`, mai da committare):
   ```bash
   cd ~/ARALD/mobile/www
   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
     -subj "/CN=192.168.1.50" -addext "subjectAltName=IP:192.168.1.50"
   ```
2. **App in HTTPS (porta 8090) e proxy verso il nodo (porta 8443 → 8080)**, in background così non muoiono con la sessione SSH (era già successo):
   ```bash
   nohup npx http-server -S -C cert.pem -K key.pem -p 8090 -a 0.0.0.0 -c-1 > /tmp/static.log 2>&1 &
   nohup npx local-ssl-proxy --source 8443 --target 8080 --cert cert.pem --key key.pem > /tmp/proxy.log 2>&1 &
   sleep 5; ss -ltn | grep -E ':8080|:8090|:8443'
   ```
   Devono comparire tutte e tre le porte.
3. **Sul telefono**, nell'ordine: aprire in una scheda `https://192.168.1.50:8443/api/status` e accettare l'avviso del certificato (necessario una volta per ogni indirizzo HTTPS, `fetch()` non permette di procedere comunque); poi aprire `https://192.168.1.50:8090/`, accettare di nuovo l'avviso, inserire come indirizzo del gateway **`https://192.168.1.50:8443`** (con lo schema) e la password di rete.
   - Se scrivendo lo schema a mano compare `http://https://...` nel messaggio d'errore (successo una volta, causa non individuata, `docs/security.md` voce #146), una scorciatoia **solo per la prova** è cambiare il default dello schema nella copia sul Box e riportarlo a fine prova: `sed -i 's|return "http://" + trimmed;|return "https://" + trimmed;|' ~/ARALD/mobile/www/app.js` (poi basta scrivere `192.168.1.50:8443`), annullata con `git checkout mobile/www/app.js`. Il default `http://` è quello giusto per un gateway normale: non va cambiato in modo permanente.
4. **Fine prova — spegnere tutto e pulire:**
   ```bash
   pkill -f http-server; pkill -f ssl-proxy
   ss -ltn | grep -E ':8090|:8443'                  # non deve stampare nulla (la 8080 resta: è il servizio)
   rm -f ~/ARALD/mobile/www/cert.pem ~/ARALD/mobile/www/key.pem /tmp/static.log /tmp/proxy.log
   cd ~/ARALD && git checkout mobile/www/app.js && git status --short
   ```
   Se `ss` mostra ancora la 8443, il proxy non ha risposto a `pkill`: `pgrep -af ssl-proxy` e `kill <PID>`.

**Per leggere gli SOS ricevuti** (serve `--expose-emergency-beacons true` nel servizio e la password di rete): `curl -sk -H "Authorization: Bearer <password>" https://192.168.1.50:8443/api/emergency-beacons`. Senza quel flag la risposta è `404`, non "lista vuota".

---

*Nota: prossimo passo pianificato è validare la mesh e il registro relay su una base di identità stabile (ora disponibile, Node ID persistente verificato) — vedi la conversazione di progetto per il piano completo.*
