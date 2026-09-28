# Come riaccendere/spegnere il prototipo ARALD Box (Orange Pi 4 Pro)

Questa guida serve per il **prototipo attuale**, non per un dispositivo finale pronto per un rifugio (quello è descritto in [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md), che non richiede mai di digitare comandi).

**Aggiornamento 28 settembre 2026 — persistenza attiva**: il software ARALD ora parte **da solo** all'accensione della scheda, come servizio di sistema (`systemd`, unità `arald-box.service`) — non serve più collegarsi via SSH e lanciare un comando ogni volta. Il resto di questa guida è aggiornato di conseguenza.

**Dati del dispositivo** (da aggiornare se cambiano):
- Utente: `orangepi`
- Indirizzo di rete: `192.168.1.8` (assegnato dal router via DHCP — può cambiare nel tempo se non reso fisso; se SSH restituisce un avviso "host key changed" dopo un cambio di indirizzo altrove sulla rete, è il sintomo tipico — vedi "Se qualcosa non torna")

## Per accenderlo

1. Ricollega l'alimentazione alla scheda.
2. Aspetta 2-3 minuti: è il tempo che impiega ad avviare Linux **e** far partire da solo il software ARALD.
3. Fatto — nessun altro passo necessario. Verifica con la sezione sotto.

## Per verificare che funzioni

Da un altro dispositivo sulla stessa rete (telefono, altro computer), apri nel browser:
```
http://192.168.1.8:8080
```
Se la pagina si carica e mostra lo stato del nodo, tutto ok — non serve nessuna sessione SSH aperta.

## Per spegnerlo in sicurezza

Il software si ferma da solo quando il sistema operativo si spegne (il servizio è gestito da `systemd`, si arresta in modo ordinato insieme al resto del sistema) — non serve fermarlo a mano prima.

1. Collegati via SSH: `ssh orangepi@192.168.1.8` (password richiesta).
2. Spegni il sistema operativo della scheda:
   ```
   sudo shutdown -h now
   ```
3. Aspetta che il LED della scheda smetta di lampeggiare (segno che è davvero spenta) — **non scollegare l'alimentazione prima**, rischia di danneggiare la scheda di memoria.
4. Solo a quel punto scollega l'alimentazione (o qualunque altro cavo, tranne la microSD).

## Comandi utili per il servizio (via SSH, solo se serve intervenire)

- Vedere se è attivo: `sudo systemctl status arald-box.service`
- Fermarlo senza spegnere la scheda: `sudo systemctl stop arald-box.service`
- Riavviarlo (es. dopo un aggiornamento del codice): `sudo systemctl restart arald-box.service`
- Vedere i log recenti: `journalctl -u arald-box.service -f` (Ctrl+C per uscire)

**Dopo aver aggiornato il codice** (`git pull` + `npm run build -w node` dentro `~/ARALD`), il servizio non ricarica da solo la nuova build — serve un `sudo systemctl restart arald-box.service` per far ripartire il nodo con le modifiche.

## Se qualcosa non torna

- **`192.168.1.8` non risponde più / SSH avvisa "host key has changed"**: quasi sempre l'indirizzo è stato temporaneamente occupato da un altro dispositivo sulla rete (non è ancora fisso) — verificare l'elenco dispositivi collegati dalla pagina di amministrazione del router. Se si conferma che è solo un cambio di indirizzo (non un problema di sicurezza reale), sul Mac: `ssh-keygen -R <vecchio-IP>` rimuove solo la voce obsoleta (nessun effetto su altri dispositivi della rete), poi si riprova la connessione.
- **Password dimenticata/da cambiare**: la password dell'utente `orangepi` può essere quella di default — per cambiarla, una volta collegati via SSH: `passwd`.

---

*Nota: prossimo passo pianificato è passare dal cavo Ethernet al solo Wi-Fi (`docs/deployment.md`, sezione "ARALD Box e PORTABLE") — quando fatto, questa guida verrà aggiornata con le nuove istruzioni di connessione.*
