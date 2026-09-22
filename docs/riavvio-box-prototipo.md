# Come riaccendere/spegnere il prototipo ARALD Box (Orange Pi 4 Pro)

Questa guida serve per il **prototipo attuale**, non per un dispositivo finale pronto per un rifugio (quello è descritto in [`guida-hardware-rifugio.md`](./guida-hardware-rifugio.md), che non richiede mai di digitare comandi). In questa fase il nodo va riavviato a mano ogni volta — non parte da solo all'accensione.

**Dati del dispositivo** (da aggiornare se cambiano):
- Utente: `orangepi`
- Indirizzo di rete: `192.168.1.8` (assegnato dal router — può cambiare nel tempo se non reso fisso)

## Per accenderlo

1. Ricollega l'alimentazione alla scheda.
2. Aspetta 1-2 minuti: è il tempo che impiega ad avviare Linux.

## Per farlo funzionare (da un Mac/PC sulla stessa rete)

1. Apri l'applicazione **Terminale**.
2. Collegati alla scheda:
   ```
   ssh orangepi@192.168.1.8
   ```
   Inserisci la password quando richiesta.
3. Una volta collegato, avvia il software:
   ```
   cd ARALD
   npm run dev -w node -- --id BOX1 --port 9001 --web-port 8080 --web-host 0.0.0.0
   ```
4. Lascia questa finestra di Terminale aperta — il programma resta acceso finché la finestra resta aperta e collegata. Se la chiudi, il nodo si ferma (non è ancora configurato per restare acceso da solo).

## Per verificare che funzioni

Da un altro dispositivo sulla stessa rete (telefono, altro computer), apri nel browser:
```
http://192.168.1.8:8080
```
Se la pagina si carica e mostra lo stato del nodo, tutto ok.

## Per spegnerlo in sicurezza

1. Nella finestra di Terminale dove sta girando il programma, premi **Ctrl+C** — questo lo ferma in modo ordinato.
2. Spegni il sistema operativo della scheda:
   ```
   sudo shutdown -h now
   ```
3. Aspetta che il LED della scheda smetta di lampeggiare (segno che è davvero spenta) — **non scollegare l'alimentazione prima**, rischia di danneggiare la scheda di memoria.
4. Solo a quel punto scollega l'alimentazione (o qualunque altro cavo, tranne la microSD).

## Se qualcosa non torna

- **`192.168.1.8` non risponde più**: l'indirizzo può essere cambiato (non è ancora fisso). Va ricontrollato — chi segue il progetto può aiutare a trovarlo di nuovo o a fissarlo in modo permanente.
- **Password dimenticata/da cambiare**: la password dell'utente `orangepi` può essere quella di default — per cambiarla, una volta collegati via SSH: `passwd`.

---

*Nota: questa è una procedura provvisoria per il prototipo. Un prossimo passo pianificato è far partire il nodo automaticamente all'accensione, così questa guida non servirà più — vedi `docs/deployment.md`, sezione "ARALD Box e PORTABLE".*
