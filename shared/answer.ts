// Resposta do agente: o último turno da conversa (o pedido, a resposta final e, se houver, o erro) tirado das entradas
// do terminal (TerminalEntry, sources/terminal.ts). Vai para a seção "Resposta" nos detalhes do agente
// (GET /api/agents/:id/answer; ui/answer.ts), para ninguém precisar abrir o terminal para ver o que o agente entregou.
import type { TerminalEntry } from './types';

export interface AgentAnswer {
  /** O último pedido (prompt) do turno; ausente se a conversa carregada não tem nenhum. */
  request?: string;
  /** Resposta final do turno (markdown): os textos do agente depois da última ferramenta. */
  answer?: string;
  /** Erro que encerrou ou atrapalhou o turno (ex.: "API Error: 401 ..."). */
  error?: string;
  /** O erro é de login vencido: a dica é rodar `claude` e /login no terminal do computador. */
  loginExpired?: boolean;
  /** Ferramentas usadas no turno. */
  tools: number;
  /** Instante da última entrada do turno. */
  at?: number;
}

const LOGIN_RE = /\/login\b|OAuth|token has expired|401\b|not logged in|invalid api key|authentication/i;

/** Último turno das entradas (da mais antiga para a mais recente). */
export function lastAnswer(entries: readonly TerminalEntry[]): AgentAnswer {
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // Comandos de barra (/model, /clear...) não são pedidos de trabalho.
    if (e.kind === 'user' && !e.text.trim().startsWith('/')) {
      start = i;
      break;
    }
  }
  const turn = entries.slice(start + 1);
  const out: AgentAnswer = { tools: 0 };
  if (start >= 0) out.request = (entries[start] as Extract<TerminalEntry, { kind: 'user' }>).text;
  let texts: string[] = [];
  let error: string | undefined;
  for (const e of turn) {
    out.at = e.at;
    if (e.kind === 'tool') {
      out.tools++;
      texts = [];
    } else if (e.kind === 'assistant' && e.text.trim()) {
      texts.push(e.text.trim());
      error = undefined;
    } else if (e.kind === 'system' && e.level === 'error') error = e.detail ? `${e.text}\n${e.detail}` : e.text;
  }
  if (texts.length) out.answer = texts.join('\n\n');
  if (error) {
    out.error = error;
    if (LOGIN_RE.test(error)) out.loginExpired = true;
  }
  return out;
}
