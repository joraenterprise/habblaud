// Visualizador de arquivos dos agentes (na conversa, ui/chat.ts): imagem, PDF, vídeo, página (o servidor manda com
// CSP sandbox), Markdown formatado, planilhas (CSV/TSV/XLSX numa tabela com abas), código e texto. O resto (docx,
// pptx, zip...) mostra o botão de baixar. Nenhum texto do arquivo passa por innerHTML.
import { tr } from '../../../shared/i18n';
import { h, setHidden } from './dom';
import { renderMarkdown } from './markdown';
import { parseCsv, readXlsx, type Sheet } from './sheet';

export interface ViewFile {
  name: string;
  ext: string;
  url: string;
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const VIDEO = new Set(['mp4', 'mov', 'webm']);
const FRAME = new Set(['pdf', 'html', 'htm']);
const SHEET_TEXT = new Set(['csv', 'tsv']);
const TEXT_MAX = 400_000;

/** Rótulo curto do tipo, para a lista de arquivos. */
export function fileKindLabel(ext: string): string {
  if (IMAGE.has(ext)) return tr('Imagem');
  if (ext === 'pdf') return 'PDF';
  if (VIDEO.has(ext)) return tr('Vídeo');
  if (ext === 'html' || ext === 'htm') return tr('Página');
  if (ext === 'md') return 'Markdown';
  if (SHEET_TEXT.has(ext) || ext === 'xlsx' || ext === 'xls' || ext === 'ods') return tr('Planilha');
  if (ext === 'docx' || ext === 'odt') return tr('Documento');
  if (ext === 'pptx') return tr('Apresentação');
  if (ext === 'zip') return 'ZIP';
  return ext ? ext.toUpperCase() : tr('Arquivo');
}

/** Arquivo que o agente citou mas que não está no disco (nunca foi criado, ou foi movido/apagado). */
class MissingFile extends Error {}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 404 && /não encontrado|not found/i.test(body.error ?? '')) throw new MissingFile(body.error);
    throw new Error(body.error ?? tr('erro {0}', [res.status]));
  }
  return res;
}

/** URLs de blob criadas para o visualizador (liberadas a cada arquivo novo). */
let blobUrl = '';

function table(sheet: Sheet): HTMLElement {
  const width = Math.max(1, ...sheet.rows.map((r) => r.length));
  const [head, ...body] = sheet.rows;
  const cells = (r: string[], tag: 'th' | 'td') => Array.from({ length: width }, (_, i) => h(tag, { text: r[i] ?? '' }));
  return h(
    'div',
    { class: 'ui-fv__sheet' },
    h('table', { class: 'ui-fv__table' }, h('thead', {}, h('tr', {}, ...cells(head ?? [], 'th'))), h('tbody', {}, ...body.map((r) => h('tr', {}, ...cells(r, 'td'))))),
    sheet.truncated ? h('p', { class: 'ui-fv__note', text: tr('Mostrando só o começo da planilha.') }) : null,
  );
}

function sheets(list: Sheet[]): HTMLElement {
  if (!list.length) return h('p', { class: 'ui-fv__note', text: tr('Planilha vazia.') });
  const holder = h('div', { class: 'ui-fv__sheet-holder' });
  const tabs = h('div', { class: 'ui-fv__tabs', role: 'tablist' });
  const show = (i: number) => {
    holder.replaceChildren(table(list[i]));
    tabs.querySelectorAll('button').forEach((b, j) => {
      b.classList.toggle('is-on', j === i);
      b.setAttribute('aria-selected', String(j === i));
    });
  };
  list.forEach((s, i) => tabs.append(h('button', { class: 'ui-fv__tab', type: 'button', role: 'tab', on: { click: () => show(i) } }, s.name)));
  setHidden(tabs, list.length < 2);
  show(0);
  return h('div', { class: 'ui-fv__sheets' }, tabs, holder);
}

/** Monta a visualização do arquivo dentro de `box` (substitui o que houver). */
export async function renderFile(box: HTMLElement, f: ViewFile): Promise<void> {
  const ext = f.ext;
  box.replaceChildren(h('p', { class: 'ui-fv__note', text: tr('Carregando…') }));
  try {
    if (IMAGE.has(ext)) {
      box.replaceChildren(h('div', { class: 'ui-fv__img-wrap' }, h('img', { class: 'ui-fv__img', attrs: { src: f.url, alt: f.name } })));
    } else if (VIDEO.has(ext)) {
      box.replaceChildren(h('video', { class: 'ui-fv__video', attrs: { src: f.url, controls: true } }));
    } else if (FRAME.has(ext)) {
      // Antes do iframe, confere que o arquivo existe: um erro dentro do iframe vira uma página em branco.
      const res = await fetchOk(f.url);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      blobUrl = '';
      if (ext === 'pdf') {
        // O PDF vai por blob (o leitor do navegador abre igual e não baixa duas vezes).
        blobUrl = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/pdf' }));
        box.replaceChildren(h('iframe', { class: 'ui-fv__frame', attrs: { src: blobUrl, title: f.name } }));
      } else {
        void res.body?.cancel();
        // Página: do próprio servidor, que já a manda com CSP sandbox; o iframe também é isolado.
        box.replaceChildren(h('iframe', { class: 'ui-fv__frame', attrs: { src: f.url, title: f.name, referrerpolicy: 'no-referrer', sandbox: '' } }));
      }
    } else if (ext === 'xlsx') {
      const buf = await (await fetchOk(f.url)).arrayBuffer();
      box.replaceChildren(sheets(await readXlsx(buf)));
    } else if (SHEET_TEXT.has(ext)) {
      const text = await (await fetchOk(f.url)).text();
      box.replaceChildren(sheets([parseCsv(text, ext === 'tsv' ? '\t' : undefined)]));
    } else if (ext === 'md') {
      const text = (await (await fetchOk(f.url)).text()).slice(0, TEXT_MAX);
      box.replaceChildren(h('div', { class: 'ui-fv__md ui-md' }, renderMarkdown(text)));
    } else if (['xls', 'ods', 'odt', 'docx', 'pptx', 'zip'].includes(ext)) {
      box.replaceChildren(
        h(
          'div',
          { class: 'ui-fv__none' },
          h('p', { text: tr('Este tipo de arquivo não tem pré-visualização aqui.') }),
          h('a', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', attrs: { href: f.url, download: f.name } }, tr('Baixar {0}', [f.name])),
        ),
      );
    } else {
      const text = await (await fetchOk(f.url)).text();
      const cut = text.length > TEXT_MAX;
      box.replaceChildren(h('pre', { class: 'ui-fv__code' }, h('code', { text: cut ? text.slice(0, TEXT_MAX) : text })));
      if (cut) box.append(h('p', { class: 'ui-fv__note', text: tr('Arquivo longo: mostrando só o começo.') }));
    }
  } catch (err) {
    if (err instanceof MissingFile) {
      box.replaceChildren(
        h(
          'div',
          { class: 'ui-fv__none' },
          h('p', { class: 'ui-fv__missing-title', text: tr('Este arquivo não existe no computador.') }),
          h('p', { text: tr('O agente citou este arquivo na resposta, mas não chegou a criá-lo (ou ele foi movido ou apagado). Peça a ele para gerar o arquivo, ou, se for um PDF de um HTML, abra o HTML e use Gerar PDF.') }),
        ),
      );
      return;
    }
    box.replaceChildren(h('p', { class: 'ui-fv__note is-error', text: tr('Não abriu: {0}', [(err as Error).message]) }));
  }
}
