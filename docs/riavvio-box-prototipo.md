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

## Da fare al prossimo intervento — identità persistente (`--identity-dir`)

**Scoperto il 28 settembre 2026**: il Node ID del Box cambia a ogni riavvio del servizio, perché il comando attuale non passa `--identity-dir`. Non è un problema urgente per un utilizzo puramente esplorativo, ma invalida trust/registro relay/connessioni peer stabilite a ogni riavvio — da correggere prima di qualunque uso più stabile.

**Prossimo aggiornamento della configurazione** (quando si riprende):
```bash
sudo nano /etc/systemd/system/arald-box.service
```
Aggiungere `--identity-dir /home/orangepi/.arald-identity` alla riga `ExecStart` (qualunque cartella va bene, basta che sia stabile e non venga mai cancellata), poi:
```bash
sudo systemctl daemon-reload
sudo systemctl restart arald-box.service
journalctl -u arald-box.service --no-pager | grep "Node ID"
```
Verificare che il Node ID resti lo stesso a un riavvio successivo (`sudo systemctl restart arald-box.service` di nuovo, poi ricontrollare).

---

*Nota: prossimo passo pianificato è validare la mesh e il registro relay su una base di identità stabile — vedi la conversazione di progetto per il piano completo.*
