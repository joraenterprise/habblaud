// Cadastro dos agentes personalizados (shared/custom-agents.ts), persistido em <dataDir>/custom-agents.json.
// Rotas em http/app.ts (/api/custom-agents); o "Novo agente" busca aqui a definição pelo id (spawn/spawn.ts).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AGENTS_MAX, parseCustomAgent, type CustomAgent } from '../../shared/custom-agents';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';

export type SaveResult = { agent: CustomAgent; created: boolean } | { error: string; status: 400 | 404 | 409 };

export class CustomAgentStore {
  private agents = new Map<string, CustomAgent>();

  /** `file` null = só em memória (testes). */
  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { agents?: unknown[] };
      for (const raw of j.agents ?? []) {
        const a = parseCustomAgent(raw);
        if ('error' in a) continue;
        const r = raw as Partial<CustomAgent>;
        const at = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : this.now());
        this.agents.set(a.id, { ...a, createdAt: at(r.createdAt), updatedAt: at(r.updatedAt) });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('custom-agents.json ilegível ({0}); sem agentes personalizados.', [errMsg(err)]));
    }
  }

  list(): CustomAgent[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): CustomAgent | undefined {
    const a = this.agents.get(id);
    return a && { ...a, tools: [...a.tools] };
  }

  /**
   * Cria (sem `id` na rota) ou substitui (`id` da rota). Na criação, um id que já existe é conflito; na edição, o id
   * do corpo é ignorado (o agente mantém o seu).
   */
  save(raw: unknown, routeId?: string): SaveResult {
    const body = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
    if (routeId) body.id = routeId;
    const a = parseCustomAgent(body);
    if ('error' in a) return { error: a.error, status: 400 };
    const old = this.agents.get(a.id);
    if (routeId && !old) return { error: tr('agente personalizado não encontrado'), status: 404 };
    if (!routeId && old) return { error: tr('já existe um agente com o id {0}', [a.id]), status: 409 };
    if (!old && this.agents.size >= AGENTS_MAX) return { error: tr('o limite é de {0} agentes', [AGENTS_MAX]), status: 409 };
    const now = this.now();
    const agent: CustomAgent = { ...a, createdAt: old?.createdAt ?? now, updatedAt: now };
    this.agents.set(a.id, agent);
    this.save_();
    return { agent: { ...agent }, created: !old };
  }

  remove(id: string): boolean {
    const ok = this.agents.delete(id);
    if (ok) this.save_();
    return ok;
  }

  private save_(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, agents: this.list() }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(tr('Não consegui gravar {0}: {1}', [this.file, errMsg(err)]));
    }
  }
}
