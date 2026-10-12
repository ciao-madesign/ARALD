/**
 * Caricamento dei pacchetti di terreno nella pagina: catalogo, scarico, decompressione gzip
 * (`DecompressionStream` del browser) e validazione. La rete è iniettabile per i test.
 */
import { BASE64_SUFFIX, type PackCatalog, type PackCatalogEntry, parseCatalog } from "../scenario-model/pack-catalog.js";
import { MAX_PACK_CELLS, type TerrainPack, decodePack } from "../scenario-model/terrain-pack.js";

/** Tetto ai byte decompressi: intestazione piccola + 3 byte per cella, con il tetto di celle dei pacchetti. */
export const MAX_UNPACKED_BYTES = 3 * MAX_PACK_CELLS + 1_100_000;

export interface FetchedResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type FetchFn = (url: string) => Promise<FetchedResponse>;

/** Decomprime gzip leggendo a blocchi e interrompendosi se supera `maxBytes` (un file non fidato non deve poter riempire la memoria). */
export async function gunzip(bytes: Uint8Array, maxBytes: number = MAX_UNPACKED_BYTES): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("Questo browser non sa decomprimere i pacchetti (manca DecompressionStream): usa un browser recente");
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Pacchetto troppo grande da decomprimere (oltre ${maxBytes} byte)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** Decodifica un file di testo in base64 (con tetto alla lunghezza e controllo dei caratteri). */
function decodeBase64(text: Uint8Array, name: string): Uint8Array {
  if (text.length > Math.ceil((MAX_UNPACKED_BYTES * 4) / 3) + 4) throw new Error(`Area "${name}": file troppo grande`);
  const str = new TextDecoder().decode(text).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(str) || str.length % 4 !== 0) throw new Error(`Area "${name}": il file non è base64 valido`);
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class PackLibrary {
  private catalogPromise: Promise<PackCatalog> | null = null;
  private readonly packs = new Map<string, Promise<TerrainPack>>();

  constructor(private readonly baseUrl: string, private readonly fetchFn: FetchFn = (u) => fetch(u)) {}

  /** Catalogo delle aree disponibili (scaricato una volta; un errore si può ritentare). */
  catalog(): Promise<PackCatalog> {
    if (!this.catalogPromise) {
      this.catalogPromise = this.fetchFn(`${this.baseUrl}index.json`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`Catalogo delle mappe non raggiungibile (${r.status})`);
          return parseCatalog(JSON.parse(new TextDecoder().decode(await r.arrayBuffer())));
        })
        .catch((e) => { this.catalogPromise = null; throw e; });
    }
    return this.catalogPromise;
  }

  async entry(id: string): Promise<PackCatalogEntry> {
    const e = (await this.catalog()).packs.find((p) => p.id === id);
    if (!e) throw new Error(`Area di terreno sconosciuta: ${id}`);
    return e;
  }

  /** Pacchetto di un'area (scaricato una volta); un errore non resta in cache. */
  load(id: string): Promise<TerrainPack> {
    let p = this.packs.get(id);
    if (!p) {
      p = this.fetchPack(id).catch((e) => { this.packs.delete(id); throw e; });
      this.packs.set(id, p);
    }
    return p;
  }

  private async fetchPack(id: string): Promise<TerrainPack> {
    const entry = await this.entry(id);
    const r = await this.fetchFn(`${this.baseUrl}${entry.file}`);
    if (!r.ok) throw new Error(`Area "${entry.name}" non raggiungibile (${r.status})`);
    let bytes: Uint8Array = new Uint8Array(await r.arrayBuffer());
    if (entry.file.endsWith(BASE64_SUFFIX)) bytes = decodeBase64(bytes, entry.name);
    if (bytes.length > MAX_UNPACKED_BYTES) throw new Error(`Area "${entry.name}": file troppo grande (${bytes.length} byte)`);
    // Normalmente è gzip; se il server (o un proxy) l'ha già decompresso, il contenuto è direttamente il pacchetto.
    const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    const pack = decodePack(isGzip ? await gunzip(bytes) : bytes);
    if (pack.header.id !== entry.id || pack.header.cols !== entry.cols || pack.header.rows !== entry.rows) throw new Error(`Area "${entry.name}": il file non corrisponde al catalogo (contiene "${pack.header.id}", ${pack.header.cols}×${pack.header.rows} celle)`);
    return pack;
  }
}
