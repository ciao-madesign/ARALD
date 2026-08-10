# protocol/

Segnaposto per la struttura finale prevista dalla specifica ([`docs/SPECIFICATION.md` §87](../docs/SPECIFICATION.md#87-struttura-della-repository-finale)):

```
protocol/
    packet/
    content/
    service/
    sync/
```

Nel prototipo attuale (Milestone 0-7) le definizioni di protocollo vivono in `node/src/packet.ts` e `node/src/content.ts`, perché un solo consumatore (`node/`) esiste ancora. Quando `gateway/` e `mobile/` inizieranno a condividere gli stessi tipi di pacchetto e di contenuto, queste definizioni andranno estratte in questo package indipendente (`protocol/packet`, `protocol/content`) per evitare duplicazione tra i package. `protocol/service` (service discovery, §35-36) e `protocol/sync` (partition sync, §33-34) non hanno ancora un'implementazione da cui estrarre codice: nascono con le rispettive milestone (11, 13).
