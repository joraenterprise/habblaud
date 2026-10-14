// Arquivos de um agente: o que ele escreveu, editou ou mandou (TerminalEntry 'tool' com `files`) e os caminhos que
// citou nas respostas, a partir das entradas da conversa. Vai para o painel de arquivos da conversa (ui/chat.ts) por
// GET /api/agents/:id/files; GET /api/agents/:id/file só serve um caminho que esteja nesta lista.
import type { TerminalEntry } from './types';

export type AgentFileHow = 'criado' | 'editado' | 'enviado' | 'citado';

export interface AgentFile {
  path: string;
  name: string;
  /** Extensão em minúsculas (sem o ponto). */
  ext: string;
  how: AgentFileHow;
  /** Última vez que o agente mexeu nele (ou o citou). */
  at: number;
}

export const AGENT_FILES_MAX = 200;

/** Extensões que vale listar (o servidor ainda confere cada uma antes de servir). */
const VIEWABLE =
  /\.(png|jpe?g|gif|webp|svg|pdf|mp4|mov|webm|html?|md|txt|csv|tsv|log|json|jsonl|ya?ml|xml|toml|sql|tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|cs|php|c|h|cpp|swift|vue|svelte|s?css|sh|ps1|bat|prisma|graphql|mermaid|mmd|xlsx?|docx|pptx|odt|ods|zip)$/i;

/** Links markdown e caminhos absolutos (Unix ou Windows) citados no texto. */
const LINK_RE = /\]\(\s*<?([^)\s>]+?)>?\s*\)/g;
const BARE_RE = /(?:^|[\s(`"'*])((?:\/|[A-Za-z]:[\\/])[^\s`"'()<>*|]+)/gm;

const WRITERS: Record<string, AgentFileHow> = { Write: 'criado', Edit: 'editado', MultiEdit: 'editado', NotebookEdit: 'editado', SendUserFile: 'enviado' };

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function fileExt(path: string): string {
  const base = fileName(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);

/** Junta um caminho relativo citado à pasta do projeto. */
function resolve(p: string, project: string | undefined): string | undefined {
  let t = p.trim().replace(/[.,;:!?]+$/, '');
  if (t.startsWith('file://')) t = t.slice(7).replace(/^\/([A-Za-z]:)/, '$1');
  try {
    t = decodeURIComponent(t);
  } catch {
    // fica como veio
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith('#')) return undefined;
  if (isAbs(t)) return t;
  if (!project) return undefined;
  const sep = /^[A-Za-z]:/.test(project) || project.includes('\\') ? '\\' : '/';
  return `${project.replace(/[\\/]+$/, '')}${sep}${t.replace(/^\.[\\/]/, '').replace(/[\\/]/g, sep)}`;
}

/** Chave para não repetir o mesmo arquivo (barras e, no Windows, maiúsculas). */
function keyOf(path: string): string {
  const k = path.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(k) ? k.toLowerCase() : k;
}

/** Arquivos do agente, do mais recente para o mais antigo. `project` resolve os caminhos relativos citados. */
export function agentFiles(entries: readonly TerminalEntry[], project?: string): AgentFile[] {
  const byKey = new Map<string, AgentFile>();
  const add = (path: string, how: AgentFileHow, at: number) => {
    if (!VIEWABLE.test(path) || path.length > 1_024) return;
    const key = keyOf(path);
    const old = byKey.get(key);
    // "criado" vale mais que "editado", que vale mais que "citado".
    const rank = { criado: 3, enviado: 3, editado: 2, citado: 1 } as const;
    const keepHow = old && rank[old.how] >= rank[how] ? old.how : how;
    byKey.set(key, { path: old?.path ?? path, name: fileName(path), ext: fileExt(path), how: keepHow, at: Math.max(old?.at ?? 0, at) });
  };
  for (const e of entries) {
    if (e.kind === 'tool' && e.files?.length) {
      const how = WRITERS[e.tool] ?? 'editado';
      for (const f of e.files) add(f, how, e.at);
    } else if (e.kind === 'assistant') {
      for (const m of e.text.matchAll(LINK_RE)) {
        const p = resolve(m[1], project);
        if (p) add(p, 'citado', e.at);
      }
      for (const m of e.text.matchAll(BARE_RE)) {
        const p = resolve(m[1], project);
        if (p) add(p, 'citado', e.at);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.at - a.at).slice(0, AGENT_FILES_MAX);
}

/**
 * O caminho está na lista do agente? (mesma comparação usada para não repetir). Também vale o PDF gerado pelo
 * escritório ao lado de um HTML do agente (relatorio.html -> relatorio.pdf).
 */
export function hasAgentFile(files: readonly AgentFile[], path: string): boolean {
  const k = keyOf(path);
  if (files.some((f) => keyOf(f.path) === k)) return true;
  if (!/\.pdf$/i.test(path)) return false;
  return files.some((f) => /\.html?$/i.test(f.path) && keyOf(f.path).replace(/\.html?$/i, '.pdf') === k.replace(/\.pdf$/i, '.pdf'));
}
