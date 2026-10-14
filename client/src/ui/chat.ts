// Conversa com o agente num modal no centro da tela, no jeito do Claude: seus pedidos em balões, as respostas em
// Markdown formatado, as ferramentas recolhidas ("Usou 3 ferramentas"), o raciocínio e os erros; ao vivo pelo mesmo
// stream do terminal (GET /api/agents/:id/terminal) e com a caixa de mensagem no rodapé (o MessageComposer, que
// manda pelo plugin habblaud-mensagens). Ao lado, os arquivos que o agente criou, editou, mandou ou citou
// (GET /api/agents/:id/files), que abrem no visualizador (ui/fileview.ts) dentro do próprio modal.
import type { AgentFile } from '../../../shared/agent-files';
import { tr } from '../../../shared/i18n';
import type { TerminalEntry } from '../../../shared/types';
import { updateAvatar } from './avatar';
import { MessageComposer } from './composer';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { fileKindLabel, renderFile } from './fileview';
import { relativeTime } from './format';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { statusLabel } from './model';
import { parseAppend, parseInit, splitToolTitle, TerminalLog, terminalUrl, type ResultEntry, type TerminalItem, type ToolEntry } from './terminal';

const RESULT_MAX = 6_000;
const FILES_REFRESH_MS = 1_500;

type ChatFile = AgentFile & { viewable?: boolean };

function fileUrl(agentId: string, path: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(path)}`;
}

function howLabel(how: AgentFile['how']): string {
  return how === 'criado' ? tr('criado') : how === 'editado' ? tr('editado') : how === 'enviado' ? tr('enviado') : tr('citado');
}

export class ChatDialog implements UiComponent {
  readonly el: HTMLDialogElement;
  private readonly avatar: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly status: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly log: HTMLElement;
  private readonly working: HTMLElement;
  private readonly side: HTMLElement;
  private readonly fileList: HTMLElement;
  private readonly filesBtn: HTMLButtonElement;
  private readonly viewer: HTMLElement;
  private readonly viewerName: HTMLElement;
  private readonly viewerPath: HTMLElement;
  private readonly viewerBody: HTMLElement;
  private readonly viewerOpen: HTMLAnchorElement;
  /** Gerar PDF (só com um HTML aberto): o computador converte com o Edge/Chrome (POST /api/agents/:id/pdf). */
  private readonly pdfBtn: HTMLButtonElement;
  private readonly viewerStatus: HTMLElement;
  /** Caminho do arquivo aberto no visualizador. */
  private viewing = '';
  private readonly composer: MessageComposer;
  private id = '';
  private source: EventSource | null = null;
  private model = new TerminalLog();
  /** Linha de cada ferramenta já na tela (para juntar o resultado quando ele chega). */
  private toolRows = new Map<string, HTMLElement>();
  /** Grupo de ferramentas aberto no fim da conversa (as seguintes entram nele). */
  private group: { el: HTMLDetailsElement; count: HTMLElement; list: HTMLElement; n: number; last: HTMLElement } | null = null;
  private files: ChatFile[] = [];
  private filesTimer: ReturnType<typeof setTimeout> | null = null;
  private stick = true;

  constructor(private readonly ctx: UiContext) {
    this.avatar = h('div', { class: 'ui-chat__avatar' });
    this.title = h('h2', { class: 'ui-chat__title' });
    this.subtitle = h('p', { class: 'ui-chat__subtitle' });
    this.status = h('span', { class: 'ui-chat__status' });
    this.filesBtn = h('button', { class: 'ui-btn ui-chat__files-btn', type: 'button', attrs: { 'aria-pressed': 'true' }, on: { click: () => this.toggleSide() } }, tr('Arquivos'));
    const termBtn = h('button', { class: 'ui-btn', type: 'button', on: { click: () => this.openTerminal() } }, tr('Terminal'));
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.close(), 'ui-icon-btn--sm');
    const head = h(
      'div',
      { class: 'ui-dialog__head ui-chat__head' },
      h('div', { class: 'ui-chat__who' }, this.avatar, h('div', {}, h('div', { class: 'ui-chat__title-row' }, this.title, this.status), this.subtitle)),
      h('div', { class: 'ui-chat__head-actions' }, this.filesBtn, termBtn, close),
    );

    this.log = h('div', { class: 'ui-chat__log' });
    this.working = h('div', { class: 'ui-chat__working', hidden: true }, h('span', { class: 'ui-chat__dots', attrs: { 'aria-hidden': 'true' } }, h('i'), h('i'), h('i')), h('span', { text: tr('Trabalhando…') }));
    this.scroll = h('div', { class: 'ui-chat__scroll' }, this.log, this.working);
    this.scroll.addEventListener('scroll', () => {
      this.stick = this.scroll.scrollHeight - this.scroll.scrollTop - this.scroll.clientHeight < 80;
    });

    this.viewerName = h('strong', { class: 'ui-chat__viewer-name' });
    this.viewerPath = h('span', { class: 'ui-chat__viewer-path' });
    this.viewerBody = h('div', { class: 'ui-chat__viewer-body' });
    this.viewerOpen = h('a', { class: 'ui-btn', attrs: { target: '_blank', rel: 'noopener' } }, tr('Abrir em nova aba')) as HTMLAnchorElement;
    this.pdfBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', hidden: true, attrs: { title: tr('Converte este HTML num PDF ao lado dele, no computador') }, on: { click: () => void this.makePdf() } }, tr('Gerar PDF'));
    this.viewerStatus = h('span', { class: 'ui-chat__viewer-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.viewer = h(
      'div',
      { class: 'ui-chat__viewer', hidden: true },
      h(
        'div',
        { class: 'ui-chat__viewer-head' },
        h('button', { class: 'ui-btn', type: 'button', on: { click: () => this.closeViewer() } }, tr('← Conversa')),
        h('div', { class: 'ui-chat__viewer-title' }, this.viewerName, this.viewerPath),
        this.viewerStatus,
        this.pdfBtn,
        this.viewerOpen,
      ),
      this.viewerBody,
    );

    this.composer = new MessageComposer(ctx, 'drawer');
    const main = h('div', { class: 'ui-chat__main' }, this.scroll, this.viewer, h('div', { class: 'ui-chat__composer' }, this.composer.el));

    this.fileList = h('ul', { class: 'ui-chat__file-list' });
    this.side = h('aside', { class: 'ui-chat__side' }, h('h3', { class: 'ui-chat__side-title', text: tr('Arquivos do agente') }), this.fileList);

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-chat', attrs: { 'aria-label': tr('Conversa com o agente') } },
      head,
      h('div', { class: 'ui-chat__body' }, main, this.side),
    ) as HTMLDialogElement;
    this.el.addEventListener('close', () => this.disconnect());
    this.el.addEventListener('cancel', (e) => {
      // Esc com um arquivo aberto volta para a conversa; sem arquivo, fecha.
      if (!this.viewer.hidden) {
        e.preventDefault();
        this.closeViewer();
      }
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get openAgentId(): string {
    return this.el.open ? this.id : '';
  }

  open(agentId: string): void {
    if (this.id !== agentId || !this.source) {
      this.disconnect();
      this.id = agentId;
      this.reset();
      this.connect();
      void this.loadFiles();
    }
    this.closeViewer();
    if (!this.el.open) this.el.showModal();
    this.render();
    requestAnimationFrame(() => this.toBottom());
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  render(): void {
    if (!this.el.open || !this.id) return;
    const a = this.ctx.agent(this.id);
    if (a) {
      updateAvatar(this.avatar, a, 'md');
      setText(this.title, a.name);
      const room = this.ctx.store.room(a.roomId);
      setText(this.subtitle, [a.title, room?.name].filter(Boolean).join(' · '));
      setText(this.status, statusLabel(a.status));
      this.status.dataset.status = a.status;
      setHidden(this.working, a.status !== 'working');
    } else {
      setText(this.status, tr('saiu do escritório'));
      setHidden(this.working, true);
    }
    this.composer.render(a);
  }

  // ---------------------------------------------------------------- conversa

  private reset(): void {
    this.model = new TerminalLog();
    this.toolRows.clear();
    this.group = null;
    this.log.replaceChildren();
    this.files = [];
    this.renderFiles();
    this.stick = true;
  }

  private connect(): void {
    const es = new EventSource(terminalUrl(this.id), { withCredentials: true });
    this.source = es;
    es.addEventListener('init', (ev) => {
      const init = parseInit((ev as MessageEvent).data);
      if (!init) return;
      this.model = new TerminalLog();
      this.toolRows.clear();
      this.group = null;
      this.log.replaceChildren();
      if (init.truncated) this.log.append(h('p', { class: 'ui-chat__note', text: tr('Mostrando só a parte mais recente da conversa.') }));
      this.push(init.entries);
      this.stick = true;
      this.toBottom();
    });
    es.addEventListener('append', (ev) => this.push(parseAppend((ev as MessageEvent).data)));
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && this.source === es) {
        this.log.append(h('p', { class: 'ui-chat__note is-error', text: tr('A conversa não abriu (o agente saiu do escritório ou o terminal está desligado).') }));
      }
    };
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = null;
  }

  private push(entries: TerminalEntry[]): void {
    if (!entries.length) return;
    const batch = this.model.push(entries);
    for (const item of batch.added) this.add(item);
    for (const { toolKey, result } of batch.attached) {
      const row = this.toolRows.get(toolKey);
      if (row) this.attachResult(row, result);
    }
    if (entries.some((e) => (e.kind === 'tool' && e.files?.length) || e.kind === 'assistant')) this.scheduleFiles();
    if (this.stick) requestAnimationFrame(() => this.toBottom());
  }

  private toBottom(): void {
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  private add(item: TerminalItem): void {
    if (item.type === 'tool') return this.addTool(item.tool, item.result, item.key);
    if (item.type === 'orphan') return;
    const e = item.entry;
    // Qualquer coisa que não seja ferramenta fecha o grupo de ferramentas aberto.
    this.group = null;
    if (e.kind === 'user') {
      const slash = e.text.trim().startsWith('/');
      this.log.append(h('div', { class: `ui-chat__user${slash ? ' is-command' : ''}` }, h('div', { class: 'ui-chat__bubble', text: e.text })));
    } else if (e.kind === 'assistant') {
      this.log.append(h('div', { class: 'ui-chat__assistant ui-md' }, renderMarkdown(e.text)));
    } else if (e.kind === 'thinking') {
      if (!e.text) return;
      const d = h('details', { class: 'ui-chat__thinking' }, h('summary', { text: tr('Pensou') }), h('div', { class: 'ui-md' }, renderMarkdown(e.text)));
      this.log.append(d);
    } else if (e.kind === 'system') {
      const cls = e.level === 'error' ? ' is-error' : e.level === 'warn' ? ' is-warn' : '';
      this.log.append(h('p', { class: `ui-chat__system${cls}`, text: e.detail ? `${e.text} — ${e.detail}` : e.text }));
    }
  }

  private addTool(tool: ToolEntry, result: ResultEntry | undefined, key: string): void {
    if (!this.group) {
      const count = h('span', { class: 'ui-chat__tools-count' });
      const last = h('span', { class: 'ui-chat__tools-last' });
      const list = h('div', { class: 'ui-chat__tools-list' });
      const el = h('details', { class: 'ui-chat__tools' }, h('summary', {}, count, last), list) as HTMLDetailsElement;
      this.group = { el, count, list, n: 0, last };
      this.log.append(el);
    }
    const g = this.group;
    g.n++;
    setText(g.count, g.n === 1 ? tr('Usou 1 ferramenta') : tr('Usou {0} ferramentas', [g.n]));
    const { name, args } = splitToolTitle(tool.title);
    setText(g.last, args ? `${name} · ${args}` : name);
    const row = h(
      'details',
      { class: 'ui-chat__tool' },
      h('summary', {}, h('span', { class: 'ui-chat__tool-name', text: name }), h('span', { class: 'ui-chat__tool-args', text: args })),
      tool.input ? h('pre', { class: `ui-chat__pre${tool.inputKind === 'diff' ? ' is-diff' : ''}`, text: tool.input }) : null,
    );
    g.list.append(row);
    if (tool.files?.length) {
      // Arquivos que esta ferramenta escreveu: chips que abrem no visualizador (fora do grupo, sempre à vista).
      const chips = h('div', { class: 'ui-chat__chips' }, ...tool.files.map((p) => this.fileChip(p)));
      this.log.append(chips);
      this.group = null;
    }
    this.toolRows.set(key, row);
    if (result) this.attachResult(row, result);
  }

  private attachResult(row: HTMLElement, r: ResultEntry): void {
    const text = r.text.length > RESULT_MAX ? `${r.text.slice(0, RESULT_MAX)}\n…` : r.text;
    if (!text.trim()) return;
    row.append(h('pre', { class: `ui-chat__pre ui-chat__result${r.error ? ' is-error' : ''}`, text }));
    if (r.error) row.classList.add('is-error');
  }

  private fileChip(path: string): HTMLElement {
    const name = path.split(/[\\/]/).pop() || path;
    return h('button', { class: 'ui-chat__chip', type: 'button', attrs: { title: path }, on: { click: () => this.openFile(path) } }, `📄 ${name}`);
  }

  // ---------------------------------------------------------------- arquivos

  private scheduleFiles(): void {
    if (this.filesTimer) return;
    this.filesTimer = setTimeout(() => {
      this.filesTimer = null;
      void this.loadFiles();
    }, FILES_REFRESH_MS);
  }

  private async loadFiles(): Promise<void> {
    const id = this.id;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/files`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok || id !== this.id) return;
      const body = (await res.json()) as { files?: ChatFile[] };
      this.files = Array.isArray(body.files) ? body.files : [];
      this.renderFiles();
    } catch {
      // fica a lista que já estava
    }
  }

  private renderFiles(): void {
    setText(this.filesBtn, this.files.length ? tr('Arquivos ({0})', [this.files.length]) : tr('Arquivos'));
    if (!this.files.length) {
      this.fileList.replaceChildren(h('li', { class: 'ui-chat__file-empty', text: tr('Nenhum arquivo ainda. Os que o agente criar, editar ou citar aparecem aqui.') }));
      return;
    }
    const now = this.ctx.now();
    this.fileList.replaceChildren(
      ...this.files.map((f) =>
        h(
          'li',
          {},
          h(
            'button',
            { class: `ui-chat__file${f.viewable === false ? ' is-off' : ''}`, type: 'button', attrs: { title: f.path }, on: { click: () => this.openFile(f.path) } },
            h('span', { class: 'ui-chat__file-ext', text: (f.ext || '?').slice(0, 4).toUpperCase() }),
            h(
              'span',
              { class: 'ui-chat__file-info' },
              h('span', { class: 'ui-chat__file-name', text: f.name }),
              h('span', { class: 'ui-chat__file-meta', text: `${fileKindLabel(f.ext)} · ${howLabel(f.how)} · ${relativeTime(f.at, now)}` }),
            ),
          ),
        ),
      ),
    );
  }

  private toggleSide(): void {
    const hidden = !this.side.hidden;
    setHidden(this.side, hidden);
    this.filesBtn.setAttribute('aria-pressed', String(!hidden));
  }

  private openFile(path: string): void {
    const f = this.files.find((x) => x.path === path);
    const name = f?.name ?? (path.split(/[\\/]/).pop() || path);
    const ext = f?.ext ?? (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
    const url = fileUrl(this.id, f?.path ?? path);
    setText(this.viewerName, name);
    setText(this.viewerPath, path);
    this.viewerOpen.href = url;
    this.viewing = f?.path ?? path;
    setHidden(this.pdfBtn, !/^html?$/.test(ext));
    setText(this.viewerStatus, '');
    setHidden(this.scroll, true);
    setHidden(this.viewer, false);
    void renderFile(this.viewerBody, { name, ext, url });
  }

  /** Converte o HTML aberto em PDF no computador e abre o PDF quando fica pronto. */
  private async makePdf(): Promise<void> {
    const id = this.id;
    const source = this.viewing;
    this.pdfBtn.disabled = true;
    setText(this.viewerStatus, tr('Gerando o PDF no computador…'));
    try {
      const api = async <T>(url: string, init?: RequestInit): Promise<T> => {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
        const body = (await res.json().catch(() => ({}))) as T & { error?: string };
        if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
        return body;
      };
      type Job = { id: string; status: string; path?: string; error?: string };
      let job = await api<Job>(`/api/agents/${encodeURIComponent(id)}/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: source }) });
      const end = Date.now() + 2 * 60_000;
      while ((job.status === 'queued' || job.status === 'sent') && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, 700));
        job = await api<Job>(`/api/projects/${encodeURIComponent(job.id)}`);
      }
      if (job.status !== 'done' || !job.path) throw new Error(job.error ?? tr('o computador não confirmou'));
      if (id !== this.id) return;
      const path = job.path;
      const name = path.split(/[\\/]/).pop() || path;
      this.files = [{ path, name, ext: 'pdf', how: 'criado', at: Date.now(), viewable: true }, ...this.files.filter((x) => x.path.toLowerCase() !== path.toLowerCase())];
      this.renderFiles();
      this.openFile(path);
    } catch (err) {
      setText(this.viewerStatus, tr('Não gerou: {0}', [(err as Error).message]));
    } finally {
      this.pdfBtn.disabled = false;
    }
  }

  private closeViewer(): void {
    setHidden(this.viewer, true);
    setHidden(this.scroll, false);
    this.viewerBody.replaceChildren();
  }

  private openTerminal(): void {
    const id = this.id;
    this.close();
    this.ctx.terminals?.open(id);
  }
}
