// Agentes personalizados: papéis salvos no Habblaud (nome, descrição, instruções, modelo, ferramentas) que o
// "Novo agente" usa para começar uma sessão do Claude Code já como aquele agente (`claude --agents <json> --agent <id>`).
// Criados pela interface (ui/agents.ts), pela skill /criar-agente do mod ou direto em /api/custom-agents.
// Validação única para o servidor, o auxiliar do host e a página (sem dependências).
import { tr } from './i18n';

export const AGENT_ID_MAX = 40;
export const AGENT_NAME_MAX = 40;
export const AGENT_DESCRIPTION_MAX = 300;
export const AGENT_PROMPT_MAX = 8_000;
export const AGENT_TOOLS_MAX = 40;
export const AGENT_TOOL_MAX = 120;
/** Quantos agentes o cadastro guarda. */
export const AGENTS_MAX = 100;

/** Modelos oferecidos na tela; '' = o padrão da conta. Outros nomes (ex.: claude-opus-5-5) também valem. */
export const AGENT_MODELS = ['', 'sonnet', 'opus', 'haiku', 'fable'] as const;
/** Modos de permissão da sessão; '' = o padrão da conta. */
export const AGENT_PERMISSION_MODES = ['', 'default', 'acceptEdits', 'plan'] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];

/** Ferramentas comuns, para escolher com um toque (lista vazia = todas). */
export const COMMON_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite'] as const;

export interface CustomAgent {
  /** Identificador (vira o nome do agente no Claude Code): minúsculas, números e hífen. */
  id: string;
  name: string;
  /** Quando usar este agente (o Claude Code exige). */
  description: string;
  /** Instruções do agente (o prompt de sistema dele). */
  prompt: string;
  model: string;
  /** Ferramentas permitidas; vazio = todas. */
  tools: string[];
  permissionMode: AgentPermissionMode;
  /** Pasta sugerida ao começar (opcional). */
  folder: string;
  createdAt: number;
  updatedAt: number;
}

/** O que a página, a skill ou a API mandam para criar ou editar. */
export type CustomAgentInput = Omit<CustomAgent, 'createdAt' | 'updatedAt'>;

/** "Revisor de Código!" -> "revisor-de-codigo". */
export function agentSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, AGENT_ID_MAX)
    .replace(/-+$/, '');
}

const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MODEL_RE = /^[A-Za-z0-9._\-[\]]{0,60}$/;
const TOOL_RE = /^[^\0\n\r]{1,120}$/;
const isAbsolutePath = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Confere um agente vindo de fora (página, skill, arquivo); devolve o agente limpo ou o motivo da recusa. */
export function parseCustomAgent(raw: unknown): CustomAgentInput | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = str(r.name).replace(/\s+/g, ' ').trim();
  if (!name || name.length > AGENT_NAME_MAX) return { error: tr('dê um nome ao agente (até {0} caracteres)', [AGENT_NAME_MAX]) };
  const id = str(r.id).trim() || agentSlug(name);
  if (!id || id.length > AGENT_ID_MAX || !ID_RE.test(id)) return { error: tr('id inválido: use minúsculas, números e hífen (até {0})', [AGENT_ID_MAX]) };
  const description = str(r.description).replace(/\s+/g, ' ').trim();
  if (!description || description.length > AGENT_DESCRIPTION_MAX) return { error: tr('descreva quando usar o agente (até {0} caracteres)', [AGENT_DESCRIPTION_MAX]) };
  const prompt = str(r.prompt).replace(/\r\n/g, '\n').trim();
  if (!prompt || prompt.length > AGENT_PROMPT_MAX || prompt.includes('\0')) return { error: tr('escreva as instruções do agente (até {0} caracteres)', [AGENT_PROMPT_MAX]) };
  const model = str(r.model).trim();
  if (!MODEL_RE.test(model)) return { error: tr('modelo inválido') };
  const rawTools = Array.isArray(r.tools) ? r.tools : typeof r.tools === 'string' ? r.tools.split(',') : [];
  const tools = [...new Set(rawTools.map((t) => str(t).trim()).filter(Boolean))];
  if (tools.length > AGENT_TOOLS_MAX || tools.some((t) => t.length > AGENT_TOOL_MAX || !TOOL_RE.test(t))) return { error: tr('lista de ferramentas inválida') };
  const permissionMode = str(r.permissionMode).trim() as AgentPermissionMode;
  if (!AGENT_PERMISSION_MODES.includes(permissionMode)) return { error: tr('modo de permissão inválido') };
  const folder = str(r.folder).trim();
  if (folder && (folder.length > 1_024 || folder.includes('\0') || !isAbsolutePath(folder))) return { error: tr('a pasta sugerida precisa ser um caminho absoluto') };
  return { id, name, description, prompt, model, tools, permissionMode, folder };
}

/** A definição que o `claude --agents` entende para este agente. */
export function agentsJson(a: Pick<CustomAgent, 'id' | 'description' | 'prompt' | 'model' | 'tools'>): string {
  return JSON.stringify({
    [a.id]: { description: a.description, prompt: a.prompt, ...(a.tools.length ? { tools: a.tools } : {}), ...(a.model ? { model: a.model } : {}) },
  });
}
