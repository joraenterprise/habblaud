// Planilhas para ver no escritório, sem biblioteca: CSV/TSV (com aspas, separador detectado) e XLSX (zip com XML,
// aberto com o DecompressionStream do navegador). Só leitura e só o que dá para mostrar numa tabela: valores, sem
// fórmulas nem formatação. Limites de linhas e colunas para a página não travar com arquivos enormes.

export const SHEET_MAX_ROWS = 2_000;
export const SHEET_MAX_COLS = 60;

export interface Sheet {
  name: string;
  rows: string[][];
  /** Havia mais linhas ou colunas do que as mostradas. */
  truncated: boolean;
}

/** Separador mais provável na primeira linha: vírgula, ponto e vírgula ou tabulação. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  const best = [',', ';', '\t'].map((c) => [c, count(c)] as const).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/** CSV (RFC 4180): aspas duplas, aspas escapadas ("") e quebras de linha dentro de aspas. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): Sheet {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  const src = text.replace(/^﻿/, '');
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (rows.length < SHEET_MAX_ROWS) {
      if (row.length > SHEET_MAX_COLS) truncated = true;
      rows.push(row.slice(0, SHEET_MAX_COLS));
    } else truncated = true;
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') endRow();
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return { name: 'CSV', rows, truncated };
}

// ---------------------------------------------------------------- zip

type ZipEntry = { method: number; compSize: number; offset: number };

/** Índice do zip (diretório central). */
function zipIndex(buf: ArrayBuffer): Map<string, ZipEntry> {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip inválido');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count && p + 46 <= buf.byteLength; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const compSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    out.set(name, { method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function zipRead(buf: ArrayBuffer, e: ZipEntry): Promise<Uint8Array> {
  const v = new DataView(buf);
  if (v.getUint32(e.offset, true) !== 0x04034b50) throw new Error('zip inválido');
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
  const data = new Uint8Array(buf, start, e.compSize);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new Error('compressão não suportada');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- xlsx

const byTag = (node: ParentNode, tag: string): Element[] => [...(node as Element | Document).getElementsByTagNameNS('*', tag)];

/** "AB12" -> índice da coluna (0 = A). */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Abre um .xlsx e devolve as planilhas (valores como texto). */
export async function readXlsx(buf: ArrayBuffer): Promise<Sheet[]> {
  const zip = zipIndex(buf);
  const xml = async (name: string): Promise<Document | undefined> => {
    const e = zip.get(name);
    if (!e) return undefined;
    return new DOMParser().parseFromString(new TextDecoder().decode(await zipRead(buf, e)), 'application/xml');
  };
  const strings: string[] = [];
  const shared = await xml('xl/sharedStrings.xml');
  if (shared) for (const si of byTag(shared, 'si')) strings.push(byTag(si, 't').map((t) => t.textContent ?? '').join(''));
  const wb = await xml('xl/workbook.xml');
  const rels = await xml('xl/_rels/workbook.xml.rels');
  const targets = new Map<string, string>();
  if (rels) for (const r of byTag(rels, 'Relationship')) targets.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '');
  const list = wb ? byTag(wb, 'sheet') : [];
  const sheets: Sheet[] = [];
  for (const s of list) {
    const rid = s.getAttribute('r:id') ?? s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? '';
    const target = (targets.get(rid) ?? '').replace(/^\/?xl\//, '').replace(/^\//, '');
    const doc = target ? await xml(`xl/${target}`) : undefined;
    if (!doc) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const r of byTag(doc, 'row')) {
      if (rows.length >= SHEET_MAX_ROWS) {
        truncated = true;
        break;
      }
      const at = Number(r.getAttribute('r') ?? rows.length + 1) - 1;
      while (rows.length < at && rows.length < SHEET_MAX_ROWS) rows.push([]);
      const row: string[] = [];
      for (const c of byTag(r, 'c')) {
        const col = c.getAttribute('r') ? columnIndex(c.getAttribute('r')!) : row.length;
        if (col >= SHEET_MAX_COLS) {
          truncated = true;
          continue;
        }
        const t = c.getAttribute('t');
        const raw = byTag(c, 'v')[0]?.textContent ?? '';
        let value = raw;
        if (t === 's') value = strings[Number(raw)] ?? '';
        else if (t === 'inlineStr') value = byTag(c, 't').map((x) => x.textContent ?? '').join('');
        else if (t === 'b') value = raw === '1' ? 'VERDADEIRO' : 'FALSO';
        while (row.length < col) row.push('');
        row[col] = value;
      }
      rows.push(row);
    }
    sheets.push({ name: s.getAttribute('name') ?? `Planilha ${sheets.length + 1}`, rows, truncated });
  }
  return sheets;
}
