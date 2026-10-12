/**
 * Decodificatore PNG minimo (8 bit per canale, RGB o RGBA, senza interlacciamento): basta per le tessere
 * "Terrarium" delle quote. Usa solo `node:zlib`, nessuna dipendenza. Input non fidato: dimensioni e
 * lunghezze dei blocchi sono controllate.
 */
import { inflateSync } from "node:zlib";

export interface DecodedPng { width: number; height: number; channels: 3 | 4; data: Uint8Array }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_SIDE = 4096;

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("Non è un PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let sawHeader = false;
  let sawEnd = false;
  while (off + 12 <= bytes.length && !sawEnd) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    if (len > bytes.length - dataStart - 4) throw new Error("PNG troncato");
    if (type === "IHDR") {
      if (len !== 13) throw new Error("PNG: intestazione non valida");
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      const interlace = bytes[dataStart + 12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) throw new Error("PNG non supportato (servono 8 bit, RGB o RGBA, senza interlacciamento)");
      if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) throw new Error("PNG: dimensioni non valide");
      sawHeader = true;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      sawEnd = true;
    }
    off = dataStart + len + 4; // il controllo CRC non serve: zlib rileva i dati corrotti
  }
  if (!sawHeader || idat.length === 0) throw new Error("PNG incompleto");
  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let p = 0;
  for (const c of idat) { joined.set(c, p); p += c.length; }
  const raw = inflateSync(joined, { maxOutputLength: (stride + 1) * height + 16 });
  if (raw.length !== (stride + 1) * height) throw new Error("PNG: dati di dimensione inattesa");
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = i >= channels && y > 0 ? out[dst - stride + i - channels] : 0;
      let v: number;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("PNG: filtro sconosciuto");
      }
      out[dst + i] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}
