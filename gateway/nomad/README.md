# gateway/nomad/

Non ancora implementato — Milestone 10-11 ([`docs/roadmap.md`](../../docs/roadmap.md)).

Traduce richieste Nomad-Net (`content://wiki/italia`, `service://ai`, ...) nell'API locale di [Project NOMAD](https://github.com/Crosstalk-Solutions/project-nomad) (Kiwix, Ollama, Qdrant, Kolibri, mappe, ...). Vedi [`docs/SPECIFICATION.md` §37, §70](../../docs/SPECIFICATION.md#37-integrazione-con-project-nomad) e [`docs/reuse-vs-new.md`](../../docs/reuse-vs-new.md) per la distinzione tra ciò che NOMAD già offre e ciò che questo gateway deve costruire.

Prerequisito: un'istanza di Project NOMAD in esecuzione (Docker, sistema Debian-based) raggiungibile dal nodo che ospita questo gateway.
