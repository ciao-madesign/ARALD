# tools/simulator/

Non ancora implementato — supporto per Milestone 20 (scalability testing) e per gli scenari di test §80 (100+ dispositivi simulati, nodo malevolo, batteria bassa, packet loss elevato).

Nel frattempo, gli scenari a piccola scala (§90-92) sono coperti direttamente da `tests/integration/`, che avvia più istanze reali di `NomadNode` in-process sullo stesso processo Node — non serve un simulatore dedicato finché il numero di nodi resta piccolo.
