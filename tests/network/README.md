# tests/network/

Test di rete a scala maggiore rispetto a `tests/integration/` (che usa pochi nodi per restare veloce). Usa `tools/simulator/simulate.ts` per collegare decine di nodi `NomadNode` reali in vari topologie (catena, anello, stella, casuale) e verificare che la consegna dei contenuti funzioni ancora al crescere della rete (spec §76-80, roadmap milestone 20).

Non ancora coperto (richiederebbe funzionalità non presenti in questo prototipo, es. simulazione di packet loss o nodi che si spostano fisicamente): 100+ dispositivi in un singolo run (il numero attuale è tenuto contenuto per mantenere la suite di test veloce — usare `npm run simulate -- --nodes 200` manualmente per numeri più alti), packet loss artificiale, nodo che cambia posizione durante l'esecuzione. Vedi [`docs/SPECIFICATION.md` §80](../../docs/SPECIFICATION.md#80-scenari-di-test) per l'elenco completo degli scenari previsti dalla specifica.
