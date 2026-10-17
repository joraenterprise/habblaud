// Banco de contas do Claude Code (claude-swap, github.com/realiti4/claude-swap, MIT): o que a página, o servidor e o
// auxiliar do host dividem. As contas ficam no claude-swap do computador dos agentes; o Habblaud lista (cswap list
// --json), troca a conta ativa (cswap switch) quando alguém pede, conecta contas novas (login do Claude numa pasta
// temporária + cswap add) e cadastra chaves de API (cswap add-token). Trocar entre assinaturas é sempre um clique de
// alguém; o automático só leva para uma conta de chave de API (paga por uso) e volta quando a assinatura tem folga.

export type SwapStatus = 'ok' | 'api_key' | 'token_expired' | 'relogin_required' | 'no_credentials' | 'foreign_credential' | 'keychain_unavailable' | 'unavailable';

export interface SwapWindow {
  /** Uso da janela (0-100+). */
  pct: number;
  /** Quando a janela reinicia (ISO). */
  resetsAt?: string;
}

export interface SwapAccount {
  number: number;
  email: string;
  organization?: string;
  alias?: string;
  active: boolean;
  disabled?: boolean;
  status: SwapStatus;
  fiveHour?: SwapWindow;
  sevenDay?: SwapWindow;
  loginExpiresAt?: string;
}

/** Acima disto (5h ou 7 dias), o escritório avisa e sugere trocar. */
export const WARN_PCT = 90;
/** A conta de assinatura esgotou (a troca automática para a API pode agir). */
export const EXHAUSTED_PCT = 100;
/** Para voltar da API para a assinatura, ela precisa estar abaixo disto. */
export const RETURN_PCT = 80;

const STATUSES = new Set<SwapStatus>(['ok', 'api_key', 'token_expired', 'relogin_required', 'no_credentials', 'foreign_credential', 'keychain_unavailable', 'unavailable']);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function window(raw: unknown): SwapWindow | undefined {
  const w = rec(raw);
  const pct = typeof w?.pct === 'number' && Number.isFinite(w.pct) ? Math.max(0, Math.min(1000, w.pct)) : undefined;
  if (pct === undefined) return undefined;
  const resetsAt = str(w?.resetsAt, 40);
  return { pct, ...(resetsAt && !Number.isNaN(Date.parse(resetsAt)) ? { resetsAt } : {}) };
}

/** Lê o `cswap list --json` (dados de fora: só os campos conhecidos, com tipos conferidos). Sem nada: lista vazia. */
export function parseSwapAccounts(raw: unknown): SwapAccount[] {
  const list = rec(raw)?.accounts;
  if (!Array.isArray(list)) return [];
  const out: SwapAccount[] = [];
  for (const item of list.slice(0, 50)) {
    const a = rec(item);
    const number = typeof a?.number === 'number' && Number.isInteger(a.number) && a.number > 0 ? a.number : undefined;
    const email = str(a?.email);
    if (!a || !number || !email) continue;
    const status = STATUSES.has(a.usageStatus as SwapStatus) ? (a.usageStatus as SwapStatus) : 'unavailable';
    const usage = rec(a.usage);
    const fiveHour = window(usage?.fiveHour);
    const sevenDay = window(usage?.sevenDay);
    const organization = str(a.organizationName);
    const alias = str(a.alias, 40);
    const loginExpiresAt = str(a.loginExpiresAt, 40);
    out.push({
      number,
      email,
      active: a.active === true,
      status,
      ...(a.disabled === true ? { disabled: true } : {}),
      ...(organization ? { organization } : {}),
      ...(alias ? { alias } : {}),
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      ...(loginExpiresAt ? { loginExpiresAt } : {}),
    });
  }
  return out.sort((x, y) => x.number - y.number);
}

/** O pior uso das duas janelas (undefined sem números, como numa conta de API). */
export function peakPct(a: SwapAccount): number | undefined {
  const values = [a.fiveHour?.pct, a.sevenDay?.pct].filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : undefined;
}

export const isApiAccount = (a: SwapAccount): boolean => a.status === 'api_key';

/** Conta de assinatura utilizável: login em ordem, não desativada e com números de uso. */
const usableSubscription = (a: SwapAccount): boolean => !a.disabled && a.status === 'ok' && peakPct(a) !== undefined;

/**
 * A conta de assinatura com mais folga para sugerir (nunca a ativa, nunca uma de API ou desativada), se ela estiver
 * abaixo do aviso. Undefined = não há para onde sugerir.
 */
export function suggestTarget(accounts: readonly SwapAccount[]): SwapAccount | undefined {
  return accounts
    .filter((a) => !a.active && usableSubscription(a) && (peakPct(a) ?? 100) < WARN_PCT)
    .sort((x, y) => (peakPct(x) ?? 100) - (peakPct(y) ?? 100) || x.number - y.number)[0];
}

/** A conta ativa merece aviso (uma das janelas acima de WARN_PCT)? */
export function needsWarning(accounts: readonly SwapAccount[]): SwapAccount | undefined {
  const active = accounts.find((a) => a.active);
  return active && !isApiAccount(active) && (peakPct(active) ?? 0) >= WARN_PCT ? active : undefined;
}

export interface ApiFallbackState {
  /** Para onde voltar quando a assinatura tiver folga (a conta que esgotou). */
  returnTo?: number;
}

export type ApiFallbackDecision = { action: 'none' } | { action: 'to-api'; target: number; returnTo: number } | { action: 'back'; target: number };

/**
 * Troca automática permitida: assinatura esgotada -> conta de chave de API (paga por uso); de volta para a assinatura
 * de onde saiu quando ela fica abaixo de RETURN_PCT. Nunca de uma assinatura para outra.
 */
export function apiFallbackDecision(accounts: readonly SwapAccount[], state: ApiFallbackState): ApiFallbackDecision {
  const active = accounts.find((a) => a.active);
  if (!active) return { action: 'none' };
  if (isApiAccount(active)) {
    const back = accounts.find((a) => a.number === state.returnTo);
    if (back && usableSubscription(back) && (peakPct(back) ?? 100) < RETURN_PCT) return { action: 'back', target: back.number };
    return { action: 'none' };
  }
  if ((peakPct(active) ?? 0) < EXHAUSTED_PCT) return { action: 'none' };
  const api = accounts.find((a) => isApiAccount(a) && !a.disabled);
  return api ? { action: 'to-api', target: api.number, returnTo: active.number } : { action: 'none' };
}

/** "Added Account 2: maria@x.com [Org]" -> {number, email}. */
export function parseAdded(text: string): { number: number; email: string } | undefined {
  const m = /Added Account (\d+):\s*(\S+@\S+)/i.exec(text);
  return m ? { number: Number(m[1]), email: m[2] } : undefined;
}

/** O link de login que o `claude auth login` imprime. */
export function parseLoginUrl(text: string): string | undefined {
  const m = /(https:\/\/(?:claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)\/[^\s"'<>]*oauth\/authorize\?[^\s"'<>]+)/.exec(text);
  return m?.[1];
}
