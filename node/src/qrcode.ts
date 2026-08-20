/**
 * Minimal QR Code encoder (ISO/IEC 18004), written from scratch against the public spec tables —
 * no external dependency, matching this codebase's "stdlib/self-written over a package" convention
 * (see CLAUDE.md). Deliberately narrow scope: byte mode only (no numeric/alphanumeric/kanji modes,
 * since every payload this project ever encodes — a pairing URI — is already a URL-safe ASCII-ish
 * string with no benefit from those), versions 1-10 only (up to 57x57, ~213 usable bytes at EC
 * level M — comfortably more than a "host:port + network name + password" pairing URI ever needs),
 * error correction level M with a fallback to L only when the payload doesn't fit any version at M.
 * `encodeQr()` returns `null` instead of throwing when even that isn't enough room — callers are
 * expected to degrade gracefully (hide the QR, keep the existing text-based pairing panel), not crash
 * spec §59-style "the interface should never crash the process over untrusted/edge-case input" — this
 * one just applies it to "the operator picked a very long network name" instead of network input.
 *
 * Verified during development against an independent decoder (jsQR, used only as a throwaway
 * development-time oracle, never added as a dependency) across payloads spanning versions 1-10 and
 * both EC levels — see tests/unit/qrcode.test.ts for the committed regression coverage, which checks
 * structural invariants and BCH self-consistency instead (adding a QR *decoder* dependency just for
 * tests would violate the same "no unnecessary dependency" rule this file exists to uphold).
 */

/** A generated QR code: a square matrix of modules, `true` = dark. */
export interface QrCode {
  version: number;
  size: number;
  matrix: boolean[][];
}

type EcLevel = "L" | "M";

interface BlockGroup {
  count: number;
  dataCodewords: number;
}

interface VersionCapacity {
  ecCodewordsPerBlock: number;
  group1: BlockGroup;
  group2?: BlockGroup;
}

// ISO/IEC 18004 Table 9 (excerpt: versions 1-10, EC levels L and M only — this project never needs
// Q/H, and dropping them halves the transcription surface for this table). Cross-checked internally
// during development: ecCodewordsPerBlock * totalBlocks + totalDataCodewords must equal the known
// total-codewords-per-version (26, 44, 70, 100, 134, 172, 196, 242, 292, 346 for versions 1-10) —
// every entry below satisfies that.
const CAPACITY: Record<number, Record<EcLevel, VersionCapacity>> = {
  1: { L: { ecCodewordsPerBlock: 7, group1: { count: 1, dataCodewords: 19 } }, M: { ecCodewordsPerBlock: 10, group1: { count: 1, dataCodewords: 16 } } },
  2: { L: { ecCodewordsPerBlock: 10, group1: { count: 1, dataCodewords: 34 } }, M: { ecCodewordsPerBlock: 16, group1: { count: 1, dataCodewords: 28 } } },
  3: { L: { ecCodewordsPerBlock: 15, group1: { count: 1, dataCodewords: 55 } }, M: { ecCodewordsPerBlock: 26, group1: { count: 1, dataCodewords: 44 } } },
  4: { L: { ecCodewordsPerBlock: 20, group1: { count: 1, dataCodewords: 80 } }, M: { ecCodewordsPerBlock: 18, group1: { count: 2, dataCodewords: 32 } } },
  5: { L: { ecCodewordsPerBlock: 26, group1: { count: 1, dataCodewords: 108 } }, M: { ecCodewordsPerBlock: 24, group1: { count: 2, dataCodewords: 43 } } },
  6: { L: { ecCodewordsPerBlock: 18, group1: { count: 2, dataCodewords: 68 } }, M: { ecCodewordsPerBlock: 16, group1: { count: 4, dataCodewords: 27 } } },
  7: { L: { ecCodewordsPerBlock: 20, group1: { count: 2, dataCodewords: 78 } }, M: { ecCodewordsPerBlock: 18, group1: { count: 4, dataCodewords: 31 } } },
  8: { L: { ecCodewordsPerBlock: 24, group1: { count: 2, dataCodewords: 97 } }, M: { ecCodewordsPerBlock: 22, group1: { count: 2, dataCodewords: 38 }, group2: { count: 2, dataCodewords: 39 } } },
  9: { L: { ecCodewordsPerBlock: 30, group1: { count: 2, dataCodewords: 116 } }, M: { ecCodewordsPerBlock: 22, group1: { count: 3, dataCodewords: 36 }, group2: { count: 2, dataCodewords: 37 } } },
  10: { L: { ecCodewordsPerBlock: 18, group1: { count: 2, dataCodewords: 68 }, group2: { count: 2, dataCodewords: 69 } }, M: { ecCodewordsPerBlock: 26, group1: { count: 4, dataCodewords: 43 }, group2: { count: 1, dataCodewords: 44 } } },
};

// ISO/IEC 18004 Table E.1 (alignment pattern center coordinates), versions 1-10. Combined pairwise
// (row x col) to get every alignment pattern center, except combinations overlapping a finder
// pattern corner (see isNearFinder()).
const ALIGNMENT_COORDS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

// Bits left over after the last full codeword that still fall inside the data region of the matrix
// (always encoded as 0 — see placeDataBits()'s default-to-0 fallback, which makes this table only
// relevant conceptually, never consumed directly).
const REMAINDER_BITS: Record<number, number> = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

// --- Galois Field GF(256) arithmetic (primitive polynomial x^8+x^4+x^3+x^2+1 = 0x11D), the same
// field QR's Reed-Solomon error correction is defined over. ---
const GF_EXP = new Array<number>(256).fill(0);
const GF_LOG = new Array<number>(256).fill(0);
(function initGaloisField(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  GF_EXP[255] = GF_EXP[0];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

function polyMul(a: number[], b: number[]): number[] {
  const result = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i], b[j]);
    }
  }
  return result;
}

function rsGeneratorPoly(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    g = polyMul(g, [1, GF_EXP[i]]);
  }
  return g;
}

/** Reed-Solomon error correction codewords for one block of data codewords. */
function rsEncode(dataCodewords: number[], ecLength: number): number[] {
  const generator = rsGeneratorPoly(ecLength);
  const buffer = dataCodewords.concat(new Array<number>(ecLength).fill(0));
  for (let i = 0; i < dataCodewords.length; i++) {
    const coef = buffer[i];
    if (coef === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      buffer[i + j] ^= gfMul(generator[j], coef);
    }
  }
  return buffer.slice(dataCodewords.length);
}

// --- Bit-level BCH codes for the format (15-bit) and version (18-bit, version >= 7 only) info
// strips placed around the finder patterns — binary polynomial division, distinct from the GF(256)
// arithmetic above (these use GF(2), i.e. plain XOR shifting). ---

const FORMAT_GENERATOR = 0b10100110111; // x^10+x^8+x^5+x^4+x^2+x+1
const FORMAT_MASK = 0b101010000010010; // fixed XOR mask applied to every format string
const VERSION_GENERATOR = 0b1111100100101; // degree-12 generator for version info

function bchRemainder(value: number, generator: number, generatorDegree: number): number {
  let v = value;
  for (let bit = 31; bit >= generatorDegree; bit--) {
    if ((v >> bit) & 1) {
      v ^= generator << (bit - generatorDegree);
    }
  }
  return v;
}

const EC_LEVEL_BITS: Record<EcLevel, number> = { L: 0b01, M: 0b00 };

function formatInfoBits(ecLevel: EcLevel, maskPattern: number): number {
  const data5 = (EC_LEVEL_BITS[ecLevel] << 3) | maskPattern; // 5 bits
  const remainder = bchRemainder(data5 << 10, FORMAT_GENERATOR, 10); // 10-bit remainder
  return ((data5 << 10) | remainder) ^ FORMAT_MASK; // 15 bits
}

function versionInfoBits(version: number): number {
  const remainder = bchRemainder(version << 12, VERSION_GENERATOR, 12); // 12-bit remainder
  return (version << 12) | remainder; // 18 bits
}

function bitAt(value: number, totalBits: number, index: number): boolean {
  return ((value >> (totalBits - 1 - index)) & 1) === 1;
}

// --- Data codeword construction (byte mode only) ---

function requiredDataBits(version: number, byteLength: number): number {
  const countBits = version <= 9 ? 8 : 16;
  return 4 /* mode indicator */ + countBits + byteLength * 8;
}

function selectVersionAndEcLevel(byteLength: number): { version: number; ecLevel: EcLevel } | undefined {
  for (const ecLevel of ["M", "L"] as const) {
    for (let version = 1; version <= 10; version++) {
      const cap = CAPACITY[version][ecLevel];
      const totalDataCodewords = cap.group1.count * cap.group1.dataCodewords + (cap.group2 ? cap.group2.count * cap.group2.dataCodewords : 0);
      if (requiredDataBits(version, byteLength) <= totalDataCodewords * 8) {
        return { version, ecLevel };
      }
    }
  }
  return undefined;
}

function pushBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
}

function bitsToByte(bits: number[]): number {
  let v = 0;
  for (const b of bits) v = (v << 1) | b;
  return v;
}

function buildDataCodewords(bytes: Uint8Array, version: number, cap: VersionCapacity, totalDataCodewords: number): number[] {
  const bits: number[] = [];
  pushBits(bits, 0b0100, 4); // byte mode indicator
  pushBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);

  const totalDataBits = totalDataCodewords * 8;
  const terminatorLength = Math.min(4, Math.max(0, totalDataBits - bits.length));
  for (let i = 0; i < terminatorLength; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bitsToByte(bits.slice(i, i + 8)));

  let padToggle = true;
  while (codewords.length < totalDataCodewords) {
    codewords.push(padToggle ? 0xec : 0x11);
    padToggle = !padToggle;
  }
  return codewords;
}

function splitIntoBlocks(codewords: number[], cap: VersionCapacity): number[][] {
  const blocks: number[][] = [];
  let idx = 0;
  for (let i = 0; i < cap.group1.count; i++) {
    blocks.push(codewords.slice(idx, idx + cap.group1.dataCodewords));
    idx += cap.group1.dataCodewords;
  }
  if (cap.group2) {
    for (let i = 0; i < cap.group2.count; i++) {
      blocks.push(codewords.slice(idx, idx + cap.group2.dataCodewords));
      idx += cap.group2.dataCodewords;
    }
  }
  return blocks;
}

function buildCodewordBits(bytes: Uint8Array, version: number, ecLevel: EcLevel): number[] {
  const cap = CAPACITY[version][ecLevel];
  const totalDataCodewords = cap.group1.count * cap.group1.dataCodewords + (cap.group2 ? cap.group2.count * cap.group2.dataCodewords : 0);
  const dataCodewords = buildDataCodewords(bytes, version, cap, totalDataCodewords);
  const blocks = splitIntoBlocks(dataCodewords, cap);
  const ecBlocks = blocks.map((block) => rsEncode(block, cap.ecCodewordsPerBlock));

  const maxDataLen = Math.max(...blocks.map((b) => b.length));
  const interleavedData: number[] = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) {
      if (i < block.length) interleavedData.push(block[i]);
    }
  }
  const interleavedEc: number[] = [];
  for (let i = 0; i < cap.ecCodewordsPerBlock; i++) {
    for (const ecBlock of ecBlocks) interleavedEc.push(ecBlock[i]);
  }

  const allCodewords = interleavedData.concat(interleavedEc);
  const bits: number[] = [];
  for (const cw of allCodewords) {
    for (let b = 7; b >= 0; b--) bits.push((cw >> b) & 1);
  }
  return bits;
}

// --- Matrix construction ---

function makeGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function placeFinderPattern(modules: boolean[][], reserved: boolean[][], topRow: number, leftCol: number, size: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = topRow + r;
      const cc = leftCol + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      reserved[rr][cc] = true;
      if (r < 0 || r > 6 || c < 0 || c > 6) {
        modules[rr][cc] = false; // separator ring
      } else {
        const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        modules[rr][cc] = isBorder || isCore;
      }
    }
  }
}

function placeTimingPatterns(modules: boolean[][], reserved: boolean[][], size: number): void {
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) {
      modules[6][i] = i % 2 === 0;
      reserved[6][i] = true;
    }
    if (!reserved[i][6]) {
      modules[i][6] = i % 2 === 0;
      reserved[i][6] = true;
    }
  }
}

function isNearFinder(row: number, col: number, size: number): boolean {
  return (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
}

function drawAlignmentPattern(modules: boolean[][], reserved: boolean[][], centerRow: number, centerCol: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const rr = centerRow + r;
      const cc = centerCol + c;
      reserved[rr][cc] = true;
      modules[rr][cc] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
    }
  }
}

function placeAlignmentPatterns(modules: boolean[][], reserved: boolean[][], version: number, size: number): void {
  const coords = ALIGNMENT_COORDS[version];
  for (const row of coords) {
    for (const col of coords) {
      if (isNearFinder(row, col, size)) continue;
      drawAlignmentPattern(modules, reserved, row, col);
    }
  }
}

function formatCopy1Coords(): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) coords.push([8, i]);
  coords.push([8, 7]);
  coords.push([8, 8]);
  coords.push([7, 8]);
  for (let i = 9; i <= 14; i++) coords.push([14 - i, 8]);
  return coords;
}

function formatCopy2Coords(size: number): Array<[number, number]> {
  // 7 cells vertically (bits 0-6, rows size-1 down to size-7), then 8 cells horizontally (bits
  // 7-14, columns size-8 up to size-1) — NOT an 8/7 split. Row (size-8) at column 8 is always
  // exactly the "always dark" module (row 4*version+9, and size-8 == 4*version+9 for every
  // version by construction: size = 17+4*version), so the vertical strip must stop one cell short
  // of it or it silently overlaps the dark module — which is what an earlier, wrong 8/7 split did
  // here, corrupting one data-region cell's reservation and producing an undecodable QR code.
  const coords: Array<[number, number]> = [];
  for (let i = 0; i <= 6; i++) coords.push([size - 1 - i, 8]);
  for (let i = 7; i <= 14; i++) coords.push([8, size - 15 + i]);
  return coords;
}

function reserveFormatInfoArea(reserved: boolean[][], size: number): void {
  for (const [r, c] of formatCopy1Coords()) reserved[r][c] = true;
  for (const [r, c] of formatCopy2Coords(size)) reserved[r][c] = true;
}

function placeFormatInfo(modules: boolean[][], formatBits: number, size: number): void {
  const copy1 = formatCopy1Coords();
  const copy2 = formatCopy2Coords(size);
  for (let i = 0; i < 15; i++) {
    const bit = bitAt(formatBits, 15, i);
    const [r1, c1] = copy1[i];
    modules[r1][c1] = bit;
    const [r2, c2] = copy2[i];
    modules[r2][c2] = bit;
  }
}

// Row-major within the 6-row x 3-column block (NOT column-major — verified against an independent
// reference implementation after an initial column-major attempt produced undecodable QR codes for
// every version >= 7), bit read LSB-first (bit i = the i-th least significant bit of the 18-bit
// value, i=0..17) — the opposite convention from how this module's own doc comments describe format
// info, but that's genuinely how the spec places version info; the two are not required to share a
// bit-ordering convention and don't.
function versionInfoCoords(size: number): Array<[[number, number], [number, number]]> {
  const coords: Array<[[number, number], [number, number]]> = [];
  for (let i = 0; i < 18; i++) {
    const r = Math.floor(i / 3);
    const c = size - 11 + (i % 3);
    coords.push([
      [r, c], // block A, top-right
      [c, r], // block B, bottom-left (transposed)
    ]);
  }
  return coords;
}

function reserveVersionInfoArea(reserved: boolean[][], size: number): void {
  for (const [a, b] of versionInfoCoords(size)) {
    reserved[a[0]][a[1]] = true;
    reserved[b[0]][b[1]] = true;
  }
}

function placeVersionInfo(modules: boolean[][], versionBits: number, size: number): void {
  const coords = versionInfoCoords(size);
  for (let i = 0; i < 18; i++) {
    const bit = ((versionBits >> i) & 1) === 1; // LSB-first — see versionInfoCoords() comment
    const [a, b] = coords[i];
    modules[a[0]][a[1]] = bit;
    modules[b[0]][b[1]] = bit;
  }
}

function placeDataBits(modules: boolean[][], reserved: boolean[][], bits: number[], size: number): void {
  let bitIndex = 0;
  let upward = true;
  let col = size - 1;
  while (col > 0) {
    if (col === 6) col--;
    for (let count = 0; count < size; count++) {
      const row = upward ? size - 1 - count : count;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex] : 0;
        modules[row][c] = bit === 1;
        bitIndex++;
      }
    }
    upward = !upward;
    col -= 2;
  }
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(source: boolean[][], reserved: boolean[][], mask: number, size: number): boolean[][] {
  const out = source.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (maskCondition(mask, r, c)) out[r][c] = !out[r][c];
    }
  }
  return out;
}

function rowRunPenalty(modules: boolean[][], r: number, size: number): number {
  let penalty = 0;
  let runLen = 1;
  let prev = modules[r][0];
  for (let c = 1; c < size; c++) {
    const v = modules[r][c];
    if (v === prev) {
      runLen++;
    } else {
      if (runLen >= 5) penalty += runLen - 5 + 3;
      runLen = 1;
      prev = v;
    }
  }
  if (runLen >= 5) penalty += runLen - 5 + 3;
  return penalty;
}

function colRunPenalty(modules: boolean[][], c: number, size: number): number {
  let penalty = 0;
  let runLen = 1;
  let prev = modules[0][c];
  for (let r = 1; r < size; r++) {
    const v = modules[r][c];
    if (v === prev) {
      runLen++;
    } else {
      if (runLen >= 5) penalty += runLen - 5 + 3;
      runLen = 1;
      prev = v;
    }
  }
  if (runLen >= 5) penalty += runLen - 5 + 3;
  return penalty;
}

const FINDER_LIKE_PATTERN_A = [true, false, true, true, true, false, true, false, false, false, false];
const FINDER_LIKE_PATTERN_B = [false, false, false, false, true, false, true, true, true, false, true];

function matchesPattern(modules: boolean[][], r: number, c: number, horizontal: boolean, pattern: boolean[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const rr = horizontal ? r : r + i;
    const cc = horizontal ? c + i : c;
    if (modules[rr][cc] !== pattern[i]) return false;
  }
  return true;
}

function computePenalty(modules: boolean[][], size: number): number {
  let penalty = 0;

  for (let r = 0; r < size; r++) penalty += rowRunPenalty(modules, r, size);
  for (let c = 0; c < size; c++) penalty += colRunPenalty(modules, c, size);

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v) penalty += 3;
    }
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      if (matchesPattern(modules, r, c, true, FINDER_LIKE_PATTERN_A) || matchesPattern(modules, r, c, true, FINDER_LIKE_PATTERN_B)) penalty += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      if (matchesPattern(modules, r, c, false, FINDER_LIKE_PATTERN_A) || matchesPattern(modules, r, c, false, FINDER_LIKE_PATTERN_B)) penalty += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) dark++;
    }
  }
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return penalty;
}

function buildMatrix(bits: number[], version: number, ecLevel: EcLevel): QrCode {
  const size = 17 + 4 * version;
  const modules = makeGrid(size);
  const reserved = makeGrid(size);

  placeFinderPattern(modules, reserved, 0, 0, size);
  placeFinderPattern(modules, reserved, 0, size - 7, size);
  placeFinderPattern(modules, reserved, size - 7, 0, size);
  placeTimingPatterns(modules, reserved, size);
  placeAlignmentPatterns(modules, reserved, version, size);

  const darkModuleRow = 4 * version + 9;
  modules[darkModuleRow][8] = true;
  reserved[darkModuleRow][8] = true;

  reserveFormatInfoArea(reserved, size);
  if (version >= 7) reserveVersionInfoArea(reserved, size);

  placeDataBits(modules, reserved, bits, size);

  let bestMask = 0;
  let bestModules = modules;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(modules, reserved, mask, size);
    const penalty = computePenalty(masked, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = masked;
    }
  }

  placeFormatInfo(bestModules, formatInfoBits(ecLevel, bestMask), size);
  if (version >= 7) placeVersionInfo(bestModules, versionInfoBits(version), size);

  return { version, size, matrix: bestModules };
}

/**
 * Encodes `text` (UTF-8 byte mode) as a QR code, choosing the smallest version (1-10) and EC level
 * (M preferred, L as a capacity fallback) that fits. Returns `undefined` when the text is too long
 * even at version 10 / EC level L (~272 bytes) — callers must handle this by not rendering a QR
 * rather than assuming one always exists (see the module doc comment).
 */
export function encodeQr(text: string): QrCode | undefined {
  const bytes = new TextEncoder().encode(text);
  const selection = selectVersionAndEcLevel(bytes.length);
  if (!selection) return undefined;
  const bits = buildCodewordBits(bytes, selection.version, selection.ecLevel);
  return buildMatrix(bits, selection.version, selection.ecLevel);
}

/**
 * Renders a QR code as a self-contained SVG string (no external assets, no script) — a single
 * merged `<path>` per row-run of dark modules, rather than one `<rect>` per module, to keep the
 * markup compact. `margin` is in modules (spec-recommended minimum quiet zone is 4).
 */
export function qrToSvg(qr: QrCode, options: { moduleSize?: number; margin?: number } = {}): string {
  const moduleSize = options.moduleSize ?? 5;
  const margin = options.margin ?? 4;
  const dim = (qr.size + margin * 2) * moduleSize;

  let path = "";
  for (let r = 0; r < qr.size; r++) {
    let c = 0;
    while (c < qr.size) {
      if (!qr.matrix[r][c]) {
        c++;
        continue;
      }
      const runStart = c;
      while (c < qr.size && qr.matrix[r][c]) c++;
      const x = (margin + runStart) * moduleSize;
      const y = (margin + r) * moduleSize;
      const w = (c - runStart) * moduleSize;
      path += `M${x} ${y}h${w}v${moduleSize}h-${w}z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
