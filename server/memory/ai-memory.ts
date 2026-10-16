// Memória do Habblaud no ai-memory (github.com/akitaonrails/ai-memory): a cada pedido concluído (as entregas,
// deliveries/deliveries.ts), publica uma página com o pedido completo, a resposta final e os arquivos que o agente
// escreveu. Os hooks do ai-memory já capturam o esqueleto de cada sessão (pedido cortado, ferramentas, handoff), mas
// sem LLM não guardam o conteúdo; esta página guarda. Como a memória é do projeto e não da conta do Claude, outra
// conta (ou outra ferramenta) que abrir o mesmo projeto encontra o que foi feito.
//
// Escopo: o ai-memory nomeia o projeto pelo remote do git (upstream, depois origin) ou pelo nome da pasta, e o
// servidor do Habblaud (no Docker) não roda git nas pastas do computador. Então ele tenta os projetos que o ai-memory
// já conhece, com o `session_id` da sessão: o servidor recusa gravar uma sessão num projeto que não é dela, e o primeiro
// que aceitar é o certo (fica guardado por pasta). Sessão que os hooks não capturaram vai para o nome da pasta.
//
// Ligado com HABBLAUD_AI_MEMORY_URL (ex.: http://host.docker.internal:49374) e HABBLAUD_AI_MEMORY_TOKEN. Fala MCP
// por HTTP sem sessão (POST /mcp, tools/call). Nunca lança: falhas ficam no status e tentam de novo depois.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeliveryInfo } from '../../shared/types';

/** Um pedido concluído com os arquivos que o agente escreveu (DeliveryIndex.written). */
export type MemoryTurn = DeliveryInfo & { written?: string[] };
import { errMsg, log } from '../log';
import { tr } from '../../shared/i18n';

export const PUBLISH_EVERY_MS = 60_000;
const PUBLISHED_MAX = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Projetos tentados por pedido (o servidor responde rápido a uma recusa). */
const TRY_MAX = 12;

export interface AiMemoryConfig {
  url: string;
  token?: string;
}

/** Configuração a partir do ambiente; undefined = desligado. */
export function aiMemoryConfig(env: NodeJS.ProcessEnv = process.env): AiMemoryConfig | undefined {
  const url = env.HABBLAUD_AI_MEMORY_URL?.trim().replace(/\/+$/, '');
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  const token = env.HABBLAUD_AI_MEMORY_TOKEN?.trim();
  return { url, ...(token ? { token } : {}) };
}

/** Nome de projeto a partir da pasta (o padrão do ai-memory sem remote do git): última pasta, minúsculas e seguro. */
export function folderProject(project: string): string {
  const base = (project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'projeto').toLowerCase();
  return base.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'projeto';
}

/** Ordem de tentativa: o nome da pasta, os que terminam com "-<pasta>" (remote do git: dono-repo) e os demais. */
export function candidateProjects(project: string, known: readonly string[]): string[] {
  const base = folderProject(project);
  const exact = known.filter((p) => p === base);
  const suffix = known.filter((p) => p !== base && (p.endsWith(`-${base}`) || p.endsWith(`/${base}`)));
  const rest = known.filter((p) => p !== base && !suffix.includes(p));
  return [...new Set([...exact, ...suffix, ...rest])].slice(0, TRY_MAX);
}

const fmt = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** Caminho da página: habblaud/pedidos/AAAA-MM-DD-<sessão>-<id curto>.md (um por pedido, estável). */
export function pagePath(d: MemoryTurn): string {
  const day = new Date(d.startedAt).toISOString().slice(0, 10);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, '').slice(0, 12) || 'x';
  // Um pedido por página: o hash do id do pedido (conta:sessão:entrada) nunca se repete entre pedidos da mesma sessão.
  const turn = createHash('sha256').update(d.id).digest('hex').slice(0, 10);
  return `habblaud/pedidos/${day}-${safe(d.sessionId.slice(0, 8))}-${turn}.md`;
}

/** A página em markdown: quem, quando, o pedido inteiro, a resposta final e os arquivos. */
export function pageBody(d: MemoryTurn): string {
  const who = [d.agentName, d.provider === 'codex' ? 'Codex' : 'Claude Code', d.account ? tr('conta {0}', [d.account]) : ''].filter(Boolean).join(' · ');
  const files = [...new Set([...(d.written ?? [])])];
  const lines = [
    `# ${d.headline || tr('Pedido concluído')}`,
    '',
    `- ${tr('Agente')}: ${who}`,
    `- ${tr('Projeto')}: ${d.project ?? '-'}`,
    `- ${tr('Sessão')}: \`${d.sessionId}\``,
    `- ${tr('Quando')}: ${fmt(d.startedAt)} → ${fmt(d.finishedAt)} · ${d.tools === 1 ? tr('1 ferramenta') : tr('{0} ferramentas', [d.tools])}`,
    '',
    `## ${tr('Pedido')}`,
    '',
    (d.fullRequest ?? d.request).trim(),
    '',
    `## ${tr('Resposta final')}`,
    '',
    d.text.trim(),
  ];
  if (files.length || d.attachments.length) {
    lines.push('', `## ${tr('Arquivos')}`, '');
    for (const f of files) lines.push(`- \`${f}\``);
    for (const a of d.attachments) if (!a.capture && !files.some((f) => f.endsWith(a.name))) lines.push(`- ${a.name}${a.caption ? ` — ${a.caption}` : ''}`);
  }
  lines.push('', `_${tr('Publicado pelo Habblaud a partir da conversa do agente.')}_`);
  return lines.join('\n');
}

type RpcResult = { ok: true; text: string } | { ok: false; error: string; code?: number };
export type Rpc = (tool: string, args: Record<string, unknown>) => Promise<RpcResult>;
export type AdminGet = (path: string) => Promise<unknown>;

/** MCP por HTTP sem sessão: um tools/call, resposta em JSON ou em SSE (uma linha `data:`). */
export function createRpc(cfg: AiMemoryConfig, fetchImpl: typeof fetch = fetch): { rpc: Rpc; adminGet: AdminGet } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  let id = 0;
  const rpc: Rpc = async (tool, args) => {
    try {
      const res = await fetchImpl(`${cfg.url}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: tool, arguments: args } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const raw = await res.text();
      const json = raw.trim().startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
      const j = JSON.parse(json) as { error?: { code?: number; message?: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      if (j.error) return { ok: false, error: j.error.message ?? 'erro', code: j.error.code };
      const text = j.result?.content?.map((c) => c.text ?? '').join('') ?? '';
      if (j.result?.isError) return { ok: false, error: text || 'erro' };
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  };
  const adminGet: AdminGet = async (path) => {
    const res = await fetchImpl(`${cfg.url}${path}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  return { rpc, adminGet };
}

export interface AiMemoryStatus {
  enabled: boolean;
  url?: string;
  published: number;
  lastAt?: number;
  lastError?: string;
}

export interface PublisherOptions {
  /** Onde guardar o que já foi publicado e o projeto de cada pasta (<dataDir>/ai-memory.json). */
  file: string | null;
  rpc: Rpc;
  adminGet: AdminGet;
  deliveries: () => Promise<MemoryTurn[]>;
  now?: () => number;
  url?: string;
}

interface State {
  published: string[];
  /** Pasta (minúsculas, barras normais) -> projeto do ai-memory. */
  projects: Record<string, string>;
}

const folderKey = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export class AiMemoryPublisher {
  private state: State = { published: [], projects: {} };
  private done = new Set<string>();
  private running = false;
  private status: AiMemoryStatus;

  constructor(private readonly o: PublisherOptions) {
    this.status = { enabled: true, ...(o.url ? { url: o.url } : {}), published: 0 };
    this.load();
  }

  info(): AiMemoryStatus {
    return { ...this.status };
  }

  /** Uma rodada: publica as entregas que ainda não foram. Nunca lança. */
  async round(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let count = 0;
    try {
      const list = (await this.o.deliveries()).filter((d) => !this.done.has(d.id) && d.project).sort((a, b) => a.finishedAt - b.finishedAt);
      if (!list.length) return 0;
      const known = await this.knownProjects();
      for (const d of list) {
        const r = await this.publish(d, known);
        if (r.ok) {
          count++;
          this.mark(d.id);
        } else {
          this.status.lastError = r.error;
          // Servidor fora do ar: não adianta seguir; a próxima rodada tenta de novo.
          if (!r.code) break;
        }
      }
      if (count) {
        this.status.published += count;
        this.status.lastAt = (this.o.now ?? Date.now)();
        delete this.status.lastError;
        this.save();
      }
    } catch (err) {
      this.status.lastError = errMsg(err);
    } finally {
      this.running = false;
    }
    return count;
  }

  private async knownProjects(): Promise<string[]> {
    try {
      const j = (await this.o.adminGet('/admin/projects')) as { projects?: Array<{ workspace_name?: string; project_name?: string }> };
      return (j.projects ?? []).filter((p) => (p.workspace_name ?? 'default') === 'default' && p.project_name).map((p) => p.project_name!);
    } catch {
      return [];
    }
  }

  /** Grava a página do pedido no projeto certo (o da sessão; senão o da pasta). */
  private async publish(d: MemoryTurn, known: string[]): Promise<RpcResult> {
    const key = folderKey(d.project!);
    const page = {
      workspace: 'default',
      path: pagePath(d),
      title: (d.headline || d.request).slice(0, 120),
      body: pageBody(d),
      tags: ['habblaud', 'pedido'],
    };
    const cached = this.state.projects[key];
    const order = cached ? [cached, ...candidateProjects(d.project!, known).filter((p) => p !== cached)] : candidateProjects(d.project!, known);
    for (const project of order) {
      const r = await this.o.rpc('memory_write_page', { ...page, project, session_id: d.sessionId });
      if (r.ok) {
        this.state.projects[key] = project;
        return r;
      }
      // A sessão não é deste projeto: tenta o próximo. Outro erro: para aqui.
      if (!/not a session of the project|unknown session|no such session/i.test(r.error)) return r;
    }
    // Sessão que os hooks não capturaram (ou de antes deles): o projeto da pasta, sem amarrar a sessão.
    const project = cached ?? folderProject(d.project!);
    const r = await this.o.rpc('memory_write_page', { ...page, project });
    if (r.ok) this.state.projects[key] ??= project;
    return r;
  }

  private mark(id: string): void {
    this.done.add(id);
    this.state.published.push(id);
    if (this.state.published.length > PUBLISHED_MAX) this.state.published = this.state.published.slice(-PUBLISHED_MAX);
  }

  private load(): void {
    if (!this.o.file) return;
    try {
      const j = JSON.parse(readFileSync(this.o.file, 'utf8')) as Partial<State>;
      this.state = { published: Array.isArray(j.published) ? j.published.filter((x) => typeof x === 'string') : [], projects: j.projects && typeof j.projects === 'object' ? j.projects : {} };
      this.done = new Set(this.state.published);
      this.status.published = this.state.published.length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('ai-memory.json ilegível ({0}); recomeçando a publicação.', [errMsg(err)]));
    }
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      writeFileSync(`${this.o.file}.tmp`, JSON.stringify(this.state, null, 2));
      renameSync(`${this.o.file}.tmp`, this.o.file);
    } catch (err) {
      log.warn(tr('Não consegui gravar {0}: {1}', [this.o.file, errMsg(err)]));
    }
  }
}
