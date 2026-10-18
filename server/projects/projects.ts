// Novo projeto pelo escritório (no "Novo agente"): cria uma pasta com git (e, se pedido, o repositório no GitHub pelo
// `gh`) ou clona um repositório, para o agente começar nela. Quem roda precisa estar no computador:
// - modo Node: o próprio servidor;
// - Docker: o auxiliar do host (scripts/codex-bridge.ts) busca os pedidos em POST /api/host/projects/poll, roda e
//   confirma em POST /api/host/projects/ack.
// O pedido `info` só consulta o computador (pasta pessoal, git, gh e as contas/organizações do GitHub) para a tela.
// O pedido `pdf` converte um HTML que um agente gerou em PDF ao lado dele, com o Edge ou o Chrome sem janela
// (--headless --print-to-pdf, perfil temporário próprio), para quem pediu um relatório em PDF a um agente sem terminal.
// Sem shell (execFile), com prazo, e cada nome conferido antes de virar argumento ou caminho.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tr } from '../../shared/i18n';

export const RUN_TIMEOUT_MS = 30_000;
export const CLONE_TIMEOUT_MS = 5 * 60_000;
export const PDF_TIMEOUT_MS = 90_000;
export const QUEUED_TIMEOUT_MS = 30_000;
/** Buscado e não confirmado: o clone pode levar até CLONE_TIMEOUT_MS. */
export const SENT_TIMEOUT_MS = CLONE_TIMEOUT_MS + 30_000;
export const KEEP_MS = 10 * 60_000;
export const HOST_PRESENCE_MS = 10_000;
const ERROR_MAX = 400;
const MAX_OPEN = 6;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_SHORT_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;
const GITHUB_URL_RE = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const GIT_URL_RE = /^(?:https:\/\/|git@)[^\s\0]{4,500}$/;

export type Visibility = 'private' | 'public';

export type ProjectJob =
  | { kind: 'info' }
  | { kind: 'create'; base: string; name: string; github?: { owner: string; visibility: Visibility } }
  | { kind: 'clone'; base: string; repo: string; name: string }
  | { kind: 'pdf'; source: string }
  // Banco de contas (claude-swap; accounts/swap-host.ts): listar, trocar a ativa, chave de API e conectar pelo login.
  | { kind: 'swap-list' }
  | { kind: 'swap-switch'; target: number }
  | { kind: 'swap-token'; token: string; label?: string }
  | { kind: 'swap-login-start' }
  | { kind: 'swap-login-finish'; loginId: string; code: string }
  | { kind: 'swap-login-cancel'; loginId: string }
  | { kind: 'swap-alias'; target: number; name: string };

export interface ProjectHostInfo {
  home: string;
  git: boolean;
  gh: boolean;
  /** Conta logada no gh (vazio sem login). */
  ghUser: string;
  /** A conta e as organizações, na ordem para a tela. */
  owners: string[];
}

export type SwapJob = Extract<ProjectJob, { kind: `swap-${string}` }>;

/** Pedido do banco de contas (claude-swap)? */
export function isSwapJob(job: ProjectJob): job is SwapJob {
  return job.kind.startsWith('swap-');
}

export type ProjectResult =
  | { ok: true; kind: 'info'; info: ProjectHostInfo }
  | { ok: true; kind: 'create' | 'clone' | 'pdf'; path: string; url?: string; note?: string }
  | { ok: true; kind: 'swap'; data: unknown }
  | { ok: false; error: string };

export type ProjectStatus = 'queued' | 'sent' | 'done' | 'failed';

export interface ProjectJobInfo {
  id: string;
  kind: ProjectJob['kind'];
  status: ProjectStatus;
  error?: string;
  path?: string;
  url?: string;
  note?: string;
  info?: ProjectHostInfo;
  /** Resultado de um pedido `swap-*` (o servidor confere o formato: accounts/bank.ts). */
  swap?: unknown;
}

const isAbs = (p: string): boolean => isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "dono/repo" ou URL do GitHub -> {owner, name}; outra URL git -> undefined (clona com git). */
export function githubRepo(repo: string): { owner: string; name: string } | undefined {
  const m = REPO_SHORT_RE.exec(repo) ?? GITHUB_URL_RE.exec(repo);
  return m ? { owner: m[1], name: m[2].replace(/\.git$/, '') } : undefined;
}

/** Nome da pasta de um clone: o do repositório. */
export function repoFolderName(repo: string): string {
  const gh = githubRepo(repo);
  if (gh) return gh.name;
  return (repo.replace(/\.git\/?$/, '').split(/[/:]/).pop() ?? '').trim();
}

/** Confere o pedido vindo da página ou da fila; devolve o pedido limpo ou o motivo da recusa. */
export function parseProjectJob(raw: unknown): ProjectJob | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kind = str(r.kind);
  if (kind === 'info') return { kind: 'info' };
  if (kind === 'swap-list' || kind === 'swap-login-start') return { kind };
  if (kind === 'swap-alias') {
    const target = Number(r.target);
    const name = str(r.name);
    if (!Number.isInteger(target) || target <= 0 || target >= 1000) return { error: tr('conta inválida') };
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) return { error: tr('apelido: até 32 letras, números, ponto, hífen ou sublinhado') };
    return { kind, target, name };
  }
  if (kind === 'swap-switch') {
    const target = Number(r.target);
    return Number.isInteger(target) && target > 0 && target < 1000 ? { kind, target } : { error: tr('conta inválida') };
  }
  if (kind === 'swap-token') {
    const token = str(r.token);
    // Chave do Console (sk-ant-api…, sk-ant-usr…) ou setup-token (sk-ant-oat…): só o formato, nada mais.
    if (!/^sk-ant-[A-Za-z0-9_-]{20,400}$/.test(token)) return { error: tr('chave inválida: use uma chave sk-ant-… do Console') };
    const label = str(r.label).replace(/[^\w@.+-]/g, '').slice(0, 80);
    return { kind, token, ...(label ? { label } : {}) };
  }
  if (kind === 'swap-login-finish' || kind === 'swap-login-cancel') {
    const loginId = str(r.loginId);
    if (!/^[0-9a-f-]{36}$/.test(loginId)) return { error: tr('login inválido') };
    if (kind === 'swap-login-cancel') return { kind, loginId };
    const code = str(r.code);
    if (!code || code.length > 512) return { error: tr('cole o código do Claude') };
    return { kind, loginId, code };
  }
  if (kind === 'pdf') {
    const source = str(r.source);
    if (!source || source.length > 1_024 || source.includes('\0') || !isAbs(source) || !/\.html?$/i.test(source)) return { error: tr('só dá para gerar PDF de um arquivo HTML (caminho absoluto)') };
    return { kind, source };
  }
  if (kind !== 'create' && kind !== 'clone') return { error: tr('pedido de projeto inválido') };
  const base = str(r.base);
  if (!base || base.length > 1_024 || base.includes('\0') || !isAbs(base)) return { error: tr('escolha onde criar (caminho absoluto de uma pasta)') };
  if (kind === 'create') {
    const name = str(r.name);
    if (!NAME_RE.test(name) || name === '.' || name === '..') return { error: tr('nome do projeto: letras, números, ponto, hífen e sublinhado (até 100)') };
    const g = r.github && typeof r.github === 'object' ? (r.github as Record<string, unknown>) : undefined;
    if (!g) return { kind, base, name };
    const owner = str(g.owner);
    if (!OWNER_RE.test(owner)) return { error: tr('dono do repositório no GitHub inválido') };
    const visibility = str(g.visibility) === 'public' ? 'public' : 'private';
    return { kind, base, name, github: { owner, visibility } };
  }
  const repo = str(r.repo);
  if (!repo || repo.length > 500 || !(githubRepo(repo) || GIT_URL_RE.test(repo))) return { error: tr('repositório inválido: use dono/repo ou a URL do git') };
  const name = str(r.name) || repoFolderName(repo);
  if (!NAME_RE.test(name) || name === '.' || name === '..') return { error: tr('nome da pasta inválido') };
  return { kind, base, repo, name };
}

export type CmdResult = { ok: true; stdout: string } | { ok: false; error: string };
export type Cmd = (bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<CmdResult>;

/** execFile sem shell; erro vira a 1ª linha útil do stderr. */
export const execCmd: Cmd = (bin, args, opts) =>
  new Promise((ok) => {
    const child = execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (err, out, stderr) => {
      if (!err) return ok({ ok: true, stdout: out ?? '' });
      const lines = [stderr, out, err.message].flatMap((t) => (t ?? '').split('\n').map((l) => l.trim())).filter(Boolean);
      const line = lines.find((l) => !/^(Cloning into|hint:)/i.test(l)) ?? `${bin} falhou`;
      ok({ ok: false, error: `${bin}: ${line}`.slice(0, ERROR_MAX) });
    });
    child.stdin?.end();
  });

/** Onde costumam estar o Edge e o Chrome (HABBLAUD_PDF_BROWSER manda no lugar deles). */
export function browserCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const own = env.HABBLAUD_PDF_BROWSER?.trim();
  if (own) return [own];
  if (platform === 'win32') {
    const pf = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((p): p is string => !!p);
    return [
      ...pf.map((p) => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...pf.map((p) => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ];
  }
  if (platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

/** O PDF ao lado do HTML: relatorio.html -> relatorio.pdf. */
export function pdfPathFor(source: string): string {
  return source.replace(/\.html?$/i, '.pdf');
}

export interface RunDeps {
  cmd?: Cmd;
  /** Auxiliar do host: o HTML precisa estar numa pasta de projeto conhecida (files.ts insideKnownFolder). */
  inside?: (path: string) => boolean;
  browsers?: string[];
  /** O banco de contas (claude-swap) deste computador; ausente = pedidos swap-* recusados. */
  swap?: {
    list(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
    switchTo(target: number): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
    addToken(token: string, label?: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
    loginStart(): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
    loginFinish(id: string, code: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
    loginCancel(id: string): { ok: true; data: unknown } | { ok: false; error: string };
    setAlias(target: number, name: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
  };
  home?: string;
  exists?: (p: string) => boolean;
  isDir?: (p: string) => boolean;
  mkdir?: (p: string) => void;
  writeFile?: (p: string, data: string) => void;
}

/** Roda um pedido de projeto neste computador. Nunca lança. */
export async function runProjectJob(job: ProjectJob, deps: RunDeps = {}): Promise<ProjectResult> {
  const cmd = deps.cmd ?? execCmd;
  const exists = deps.exists ?? existsSync;
  const isDir =
    deps.isDir ??
    ((p: string) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  try {
    if (job.kind === 'info') {
      const git = (await cmd('git', ['--version'], {})).ok;
      const user = await cmd('gh', ['api', 'user', '--jq', '.login'], {});
      const ghUser = user.ok ? user.stdout.trim() : '';
      const orgs = ghUser ? await cmd('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login'], {}) : undefined;
      const owners = [ghUser, ...(orgs?.ok ? orgs.stdout.split('\n').map((s) => s.trim()) : [])].filter((o) => o && OWNER_RE.test(o));
      return { ok: true, kind: 'info', info: { home: deps.home ?? homedir(), git, gh: !!ghUser, ghUser, owners: [...new Set(owners)] } };
    }
    if (isSwapJob(job)) {
      const swap = deps.swap;
      if (!swap) return { ok: false, error: tr('o banco de contas (claude-swap) não está neste computador') };
      const r =
        job.kind === 'swap-list'
          ? await swap.list()
          : job.kind === 'swap-switch'
            ? await swap.switchTo(job.target)
            : job.kind === 'swap-token'
              ? await swap.addToken(job.token, job.label)
              : job.kind === 'swap-login-start'
                ? await swap.loginStart()
                : job.kind === 'swap-login-finish'
                  ? await swap.loginFinish(job.loginId, job.code)
                  : job.kind === 'swap-login-cancel'
                    ? swap.loginCancel(job.loginId)
                    : job.kind === 'swap-alias'
                      ? await swap.setAlias(job.target, job.name)
                      : { ok: false as const, error: tr('pedido de conta inválido') };
      return r.ok ? { ok: true, kind: 'swap', data: r.data } : { ok: false, error: r.error };
    }
    if (job.kind === 'pdf') {
      if (!exists(job.source)) return { ok: false, error: tr('o HTML não existe neste computador') };
      if (deps.inside && !deps.inside(job.source)) return { ok: false, error: tr('o HTML não está numa pasta de projeto conhecida') };
      const browser = (deps.browsers ?? browserCandidates()).find((b) => exists(b));
      if (!browser) return { ok: false, error: tr('não achei o Edge nem o Chrome neste computador (defina HABBLAUD_PDF_BROWSER)') };
      const out = pdfPathFor(job.source);
      // Perfil próprio: com o navegador já aberto, sem ele o pedido iria para a janela aberta e nada seria impresso.
      const profile = mkdtempSync(join(tmpdir(), 'habblaud-pdf-'));
      try {
        const r = await cmd(
          browser,
          ['--headless', '--disable-gpu', '--no-first-run', '--no-pdf-header-footer', `--user-data-dir=${profile}`, `--print-to-pdf=${out}`, pathToFileURL(job.source).href],
          { timeoutMs: PDF_TIMEOUT_MS },
        );
        if (!exists(out)) return { ok: false, error: r.ok ? tr('o navegador não gerou o PDF') : r.error };
      } finally {
        try {
          rmSync(profile, { recursive: true, force: true });
        } catch {
          // pasta temporária: o sistema limpa depois
        }
      }
      return { ok: true, kind: 'pdf', path: out };
    }
    if (!isDir(job.base)) return { ok: false, error: tr('a pasta {0} não existe neste computador', [job.base]) };
    const path = join(job.base, job.name);
    if (exists(path)) return { ok: false, error: tr('já existe {0}', [path]) };
    if (job.kind === 'clone') {
      const gh = githubRepo(job.repo);
      const r = gh ? await cmd('gh', ['repo', 'clone', `${gh.owner}/${gh.name}`, path], { timeoutMs: CLONE_TIMEOUT_MS }) : await cmd('git', ['clone', '--', job.repo, path], { timeoutMs: CLONE_TIMEOUT_MS });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, kind: 'clone', path, ...(gh ? { url: `https://github.com/${gh.owner}/${gh.name}` } : {}) };
    }
    (deps.mkdir ?? ((p: string) => mkdirSync(p)))(path);
    (deps.writeFile ?? writeFileSync)(join(path, 'README.md'), `# ${job.name}\n`);
    for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', tr('Primeiro commit')]]) {
      const r = await cmd('git', args, { cwd: path });
      if (!r.ok) return { ok: true, kind: 'create', path, note: tr('pasta criada, mas o git parou: {0}', [r.error]) };
    }
    if (!job.github) return { ok: true, kind: 'create', path };
    const full = `${job.github.owner}/${job.name}`;
    const r = await cmd('gh', ['repo', 'create', full, `--${job.github.visibility}`, '--source', '.', '--remote', 'origin', '--push'], { cwd: path, timeoutMs: CLONE_TIMEOUT_MS });
    if (!r.ok) return { ok: true, kind: 'create', path, note: tr('repositório local criado, mas o GitHub recusou: {0}', [r.error]) };
    return { ok: true, kind: 'create', path, url: `https://github.com/${full}` };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, ERROR_MAX) };
  }
}

interface Entry {
  info: ProjectJobInfo;
  job: ProjectJob;
  at: number;
}

export type ProjectSubmit = { job: ProjectJobInfo } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };

export interface ProjectServiceOptions {
  /** Modo Node: roda aqui mesmo. Ausente (Docker): fica na fila para o auxiliar do host. */
  run?: (job: ProjectJob) => Promise<ProjectResult>;
  now?: () => number;
  newId?: () => string;
}

export class ProjectService {
  private readonly entries = new Map<string, Entry>();
  private hostSeenAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: ProjectServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  available(): boolean {
    return !!this.opts.run || this.now() - this.hostSeenAt <= HOST_PRESENCE_MS;
  }

  submit(raw: unknown): ProjectSubmit {
    this.prune();
    const job = parseProjectJob(raw);
    if ('error' in job) return { error: 'invalid', reason: job.error };
    if (!this.available()) return { error: 'unavailable', reason: tr('o auxiliar do computador não está rodando: deixe npm run codex:bridge no ar (o Habblaud está no Docker)') };
    let open = 0;
    for (const e of this.entries.values()) if (e.info.status === 'queued' || e.info.status === 'sent') open++;
    if (open >= MAX_OPEN) return { error: 'too-many', reason: tr('já há {0} pedidos de projeto em andamento', [MAX_OPEN]) };
    const info: ProjectJobInfo = { id: this.opts.newId?.() ?? randomUUID(), kind: job.kind, status: 'queued' };
    const entry: Entry = { info, job, at: this.now() };
    this.entries.set(info.id, entry);
    if (this.opts.run) {
      info.status = 'sent';
      void this.opts.run(job).then((r) => this.resolve(entry, r));
    }
    return { job: { ...info } };
  }

  get(id: string): ProjectJobInfo | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Rodada do auxiliar: marca presença e entrega os pedidos na fila. */
  poll(): Array<{ id: string } & ProjectJob> {
    this.hostSeenAt = this.now();
    this.prune();
    const out: Array<{ id: string } & ProjectJob> = [];
    for (const e of this.entries.values()) {
      if (e.info.status !== 'queued') continue;
      e.info.status = 'sent';
      e.at = this.now();
      out.push({ id: e.info.id, ...e.job });
    }
    return out;
  }

  ack(raw: unknown): void {
    this.hostSeenAt = this.now();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.info.status !== 'sent') continue;
      this.resolve(e, parseResult(x, e.job.kind));
    }
  }

  private resolve(e: Entry, r: ProjectResult): void {
    if (e.job.kind === 'swap-token') e.job = { ...e.job, token: '' };
    if (e.job.kind === 'swap-login-finish') e.job = { ...e.job, code: '' };
    e.info.status = r.ok ? 'done' : 'failed';
    if (!r.ok) e.info.error = r.error.slice(0, ERROR_MAX);
    else if (r.kind === 'info') e.info.info = r.info;
    else if (r.kind === 'swap') e.info.swap = r.data;
    else {
      e.info.path = r.path;
      if (r.url) e.info.url = r.url;
      if (r.note) e.info.note = r.note.slice(0, ERROR_MAX);
    }
    e.at = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.at;
      if (e.info.status === 'queued' && age > QUEUED_TIMEOUT_MS) this.resolve(e, { ok: false, error: tr('o auxiliar do computador não buscou o pedido') });
      else if (e.info.status === 'sent' && age > SENT_TIMEOUT_MS) this.resolve(e, { ok: false, error: tr('o auxiliar do computador não confirmou') });
      else if ((e.info.status === 'done' || e.info.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}

/** Resultado vindo do auxiliar (dados de fora: confere tipos e tamanhos). */
function parseResult(x: Record<string, unknown>, kind: ProjectJob['kind']): ProjectResult {
  if (kind.startsWith('swap-')) {
    if (x.ok !== true) return { ok: false, error: str(x.error) || tr('o auxiliar não conseguiu') };
    // Dados de fora: só passam se forem JSON pequeno (o banco de contas confere o formato de cada campo).
    const data = x.data ?? {};
    return JSON.stringify(data).length <= 200_000 ? { ok: true, kind: 'swap', data } : { ok: false, error: tr('resposta grande demais') };
  }
  if (x.ok !== true) return { ok: false, error: str(x.error) || tr('o auxiliar não conseguiu') };
  if (kind === 'info') {
    const i = x.info && typeof x.info === 'object' ? (x.info as Record<string, unknown>) : {};
    const owners = Array.isArray(i.owners) ? i.owners.map(str).filter((o) => OWNER_RE.test(o)).slice(0, 100) : [];
    return { ok: true, kind, info: { home: str(i.home).slice(0, 1_024), git: i.git === true, gh: i.gh === true, ghUser: OWNER_RE.test(str(i.ghUser)) ? str(i.ghUser) : '', owners } };
  }
  const path = str(x.path);
  if (!path || !isAbs(path) || path.length > 1_200) return { ok: false, error: tr('o auxiliar devolveu um caminho inválido') };
  const url = str(x.url);
  const note = str(x.note);
  if (kind !== 'create' && kind !== 'clone' && kind !== 'pdf') return { ok: false, error: tr('o auxiliar devolveu um resultado inesperado') };
  return { ok: true, kind, path, ...(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(url) ? { url } : {}), ...(note ? { note } : {}) };
}
