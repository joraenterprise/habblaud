// Novo projeto (no "Novo agente"): modal que cria uma pasta com git (e, se marcado, o repositório no GitHub) ou clona
// um repositório, no computador (POST /api/projects; server/projects/projects.ts). Ao terminar, devolve o caminho para
// o Novo agente já escolher a pasta. Abre consultando o computador (pedido `info`: pasta pessoal e contas do GitHub).
import { tr } from '../../../shared/i18n';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

const POLL_MS = 700;
/** Mais que o servidor espera (fila 30 s + clone 5 min). */
const WAIT_MS = 6 * 60_000;
const BASE_KEY = 'habblaud.project.base';
const OWNER_KEY = 'habblaud.project.owner';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

interface HostInfo {
  home: string;
  git: boolean;
  gh: boolean;
  ghUser: string;
  owners: string[];
}

interface JobInfo {
  id: string;
  status: 'queued' | 'sent' | 'done' | 'failed';
  error?: string;
  path?: string;
  url?: string;
  note?: string;
  info?: HostInfo;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body;
}

async function runJob(body: object): Promise<JobInfo> {
  let info = await api<JobInfo>('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const end = Date.now() + WAIT_MS;
  while ((info.status === 'queued' || info.status === 'sent') && Date.now() < end) {
    await new Promise((ok) => setTimeout(ok, POLL_MS));
    info = await api<JobInfo>(`/api/projects/${encodeURIComponent(info.id)}`);
  }
  return info;
}

/** Pastas de sistema e temporárias (as sessões de rascunho do app moram aí): nunca viram sugestão de onde criar. */
const NOT_A_HOME_FOR_PROJECTS = /[\\/](AppData|Temp|tmp|\.cache|Library[\\/]Application Support)([\\/]|$)/i;

/** Pastas-mãe das pastas recentes (onde a pessoa costuma criar projetos), sem repetir. */
export function parentFolders(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const parent = p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
    if (NOT_A_HOME_FOR_PROJECTS.test(parent)) continue;
    if (parent && parent !== p && /^(\/|[A-Za-z]:[\\/])./.test(parent) && !out.includes(parent)) out.push(parent);
  }
  return out;
}

/** Nome da pasta de um clone (o do repositório). */
export function repoName(repo: string): string {
  return (repo.trim().replace(/\.git\/?$/, '').split(/[/:]/).pop() ?? '').trim();
}

function joinPath(base: string, name: string): string {
  const sep = /^[A-Za-z]:/.test(base) || base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function readPref(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writePref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // sem armazenamento: só não lembra
  }
}

export class ProjectDialog {
  readonly el: HTMLDialogElement;
  private mode: 'create' | 'clone' = 'create';
  private readonly tabCreate: HTMLButtonElement;
  private readonly tabClone: HTMLButtonElement;
  private readonly createBox: HTMLElement;
  private readonly cloneBox: HTMLElement;
  private readonly base: HTMLInputElement;
  private readonly baseList: HTMLDataListElement;
  private readonly name: HTMLInputElement;
  private readonly github: HTMLInputElement;
  private readonly ghBox: HTMLElement;
  private readonly owner: HTMLSelectElement;
  private readonly visibility: HTMLSelectElement;
  private readonly ghHint: HTMLElement;
  private readonly repo: HTMLInputElement;
  private readonly cloneName: HTMLInputElement;
  private readonly preview: HTMLElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private info: HostInfo | null = null;
  private busy = false;
  private onDone: (path: string) => void = () => {};

  constructor() {
    const tab = (label: string, mode: 'create' | 'clone') =>
      h('button', { class: 'ui-proj__tab', type: 'button', role: 'tab', on: { click: () => this.setMode(mode) } }, label);
    this.tabCreate = tab(tr('Criar novo'), 'create');
    this.tabClone = tab(tr('Clonar do GitHub'), 'clone');
    this.baseList = h('datalist', { attrs: { id: 'ui-proj-bases' } });
    this.base = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-proj-base', list: 'ui-proj-bases', placeholder: 'C:\\Users\\voce\\projetos', autocomplete: 'off', spellcheck: 'false' } });
    this.name = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-proj-name', placeholder: 'meu-projeto', maxlength: 100, autocomplete: 'off', spellcheck: 'false' } });
    this.github = h('input', { type: 'checkbox', attrs: { id: 'ui-proj-gh' } });
    this.owner = h('select', { class: 'ui-rename__input', attrs: { id: 'ui-proj-owner' } });
    this.visibility = h('select', { class: 'ui-rename__input', attrs: { id: 'ui-proj-vis' } }, h('option', { attrs: { value: 'private' } }, tr('Privado')), h('option', { attrs: { value: 'public' } }, tr('Público')));
    this.ghHint = h('p', { class: 'ui-rename__hint' });
    const label = (id: string, text: string) => h('label', { class: 'ui-spawn__label', attrs: { for: id }, text });
    this.ghBox = h('div', { class: 'ui-agents__row' }, h('div', {}, label('ui-proj-owner', tr('Dono')), this.owner), h('div', {}, label('ui-proj-vis', tr('Visibilidade')), this.visibility));
    this.createBox = h(
      'div',
      {},
      label('ui-proj-name', tr('Nome da pasta')),
      this.name,
      h('label', { class: 'ui-proj__check' }, this.github, h('span', { text: tr('Criar o repositório no GitHub e enviar o primeiro commit') })),
      this.ghBox,
      this.ghHint,
    );
    this.repo = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-proj-repo', placeholder: tr('dono/repo ou https://github.com/dono/repo'), autocomplete: 'off', spellcheck: 'false' } });
    this.cloneName = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-proj-clone-name', placeholder: tr('igual ao repositório'), maxlength: 100, autocomplete: 'off', spellcheck: 'false' } });
    this.cloneBox = h('div', { hidden: true }, label('ui-proj-repo', tr('Repositório')), this.repo, label('ui-proj-clone-name', tr('Nome da pasta (opcional)')), this.cloneName);
    this.preview = h('p', { class: 'ui-proj__preview' });
    this.submitBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-spawn__go', type: 'button', on: { click: () => void this.submit() } }, tr('Criar projeto'));
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    for (const f of [this.base, this.name, this.repo, this.cloneName]) {
      f.addEventListener('input', () => this.renderPreview());
      f.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          void this.submit();
        }
      });
      f.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.github.addEventListener('change', () => this.renderGithub());
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.el.close(), 'ui-icon-btn--sm');
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-proj', attrs: { 'aria-label': tr('Novo projeto') } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Novo projeto') }), close),
      h(
        'div',
        { class: 'ui-proj__body' },
        h('div', { class: 'ui-proj__tabs', role: 'tablist' }, this.tabCreate, this.tabClone),
        label('ui-proj-base', tr('Onde')),
        this.base,
        this.baseList,
        this.createBox,
        this.cloneBox,
        this.preview,
        this.submitBtn,
        this.status,
      ),
    ) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && !this.busy) this.el.close();
    });
    this.el.addEventListener('cancel', (e) => {
      if (this.busy) e.preventDefault();
    });
    this.setMode('create');
  }

  /** Abre com as pastas recentes (as pastas-mãe viram sugestões de onde criar). */
  open(recent: readonly string[], onDone: (path: string) => void): void {
    this.onDone = onDone;
    const bases = parentFolders(recent);
    this.baseList.replaceChildren(...bases.map((b) => h('option', { attrs: { value: b } })));
    if (!this.base.value) this.base.value = readPref(BASE_KEY) || bases[0] || '';
    this.renderPreview();
    if (!this.el.open) this.el.showModal();
    (this.mode === 'create' ? this.name : this.repo).focus();
    if (!this.info) void this.loadInfo();
  }

  private async loadInfo(): Promise<void> {
    this.say(tr('Conferindo o git e o GitHub no computador…'));
    try {
      const r = await runJob({ kind: 'info' });
      if (r.status !== 'done' || !r.info) throw new Error(r.error ?? tr('o computador não respondeu'));
      this.info = r.info;
      if (!this.base.value && r.info.home) this.base.value = r.info.home;
      this.say('');
    } catch (err) {
      this.say((err as Error).message, true);
    }
    this.renderGithub();
    this.renderPreview();
  }

  private setMode(mode: 'create' | 'clone'): void {
    this.mode = mode;
    for (const [btn, on] of [[this.tabCreate, mode === 'create'], [this.tabClone, mode === 'clone']] as const) {
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', String(on));
    }
    setHidden(this.createBox, mode !== 'create');
    setHidden(this.cloneBox, mode !== 'clone');
    setText(this.submitBtn, mode === 'create' ? tr('Criar projeto') : tr('Clonar'));
    this.renderPreview();
  }

  private renderGithub(): void {
    const info = this.info;
    const gh = !!info?.gh;
    this.github.disabled = !gh;
    if (!gh) this.github.checked = false;
    else if (!this.github.dataset.touched) {
      this.github.checked = true;
      this.github.dataset.touched = '1';
    }
    if (gh && info) {
      const pref = readPref(OWNER_KEY);
      this.owner.replaceChildren(...info.owners.map((o) => h('option', { attrs: { value: o } }, o === info.ghUser ? tr('{0} (você)', [o]) : o)));
      this.owner.value = info.owners.includes(pref) ? pref : info.ghUser;
    }
    setHidden(this.ghBox, !this.github.checked);
    setText(this.ghHint, info && !gh ? tr('GitHub indisponível: instale o gh e rode gh auth login no computador. O projeto ainda sai com git local.') : '');
  }

  private renderPreview(): void {
    const base = this.base.value.trim();
    const name = this.mode === 'create' ? this.name.value.trim() : this.cloneName.value.trim() || repoName(this.repo.value);
    setText(this.preview, base && name ? tr('Pasta: {0}', [joinPath(base, name)]) : '');
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const base = this.base.value.trim();
    if (!base) return this.say(tr('Escolha onde criar.'), true);
    let body: object;
    if (this.mode === 'create') {
      const name = this.name.value.trim();
      if (!NAME_RE.test(name)) return this.say(tr('Nome: letras, números, ponto, hífen e sublinhado.'), true);
      body = { kind: 'create', base, name, ...(this.github.checked ? { github: { owner: this.owner.value, visibility: this.visibility.value } } : {}) };
    } else {
      const repo = this.repo.value.trim();
      if (!repo) return this.say(tr('Diga qual repositório clonar.'), true);
      body = { kind: 'clone', base, repo, ...(this.cloneName.value.trim() ? { name: this.cloneName.value.trim() } : {}) };
    }
    this.busy = true;
    this.submitBtn.disabled = true;
    this.say(this.mode === 'create' ? tr('Criando no computador…') : tr('Clonando no computador…'));
    try {
      const r = await runJob(body);
      if (r.status !== 'done' || !r.path) throw new Error(r.error ?? tr('o computador não confirmou'));
      writePref(BASE_KEY, base);
      if (this.mode === 'create' && this.github.checked) writePref(OWNER_KEY, this.owner.value);
      this.name.value = '';
      this.repo.value = '';
      this.cloneName.value = '';
      this.say(r.note ? tr('Pronto, com um aviso: {0}', [r.note]) : '', !!r.note);
      if (!r.note) this.el.close();
      this.onDone(r.path);
    } catch (err) {
      this.say(tr('Não deu: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
    }
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}
