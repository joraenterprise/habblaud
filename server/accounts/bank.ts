// Banco de contas no servidor (shared/swap.ts): guarda a última lista do claude-swap, atualiza a cada poucos minutos,
// e manda ao computador (pedidos swap-* de projects/projects.ts) o que alguém pediu: trocar a conta ativa, conectar
// uma conta pelo login do Claude, cadastrar uma chave de API. A única troca que acontece sozinha é a de uma assinatura
// esgotada para uma conta de chave de API (e a volta), e só com essa opção ligada (<dataDir>/swap.json).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { apiFallbackDecision, needsWarning, parseSwapAccounts, suggestTarget, type SwapAccount } from '../../shared/swap';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import type { ProjectJobInfo, ProjectService } from '../projects/projects';

export const REFRESH_MS = 2 * 60_000;
const JOB_WAIT_MS = 120_000;

export interface SwapSettings {
  /** Assinatura esgotada -> conta de chave de API (e volta quando ela tiver folga). Desligado por padrão. */
  autoApi: boolean;
}

export interface SwapView {
  available: boolean;
  accounts: SwapAccount[];
  fetchedAt?: number;
  lastError?: string;
  settings: SwapSettings;
  /** A conta ativa passou do aviso: ela e a sugestão de para onde trocar. */
  warning?: { active: number; suggestion?: number };
  /** A última troca automática para a API (ou a volta), para o escritório mostrar. */
  lastAuto?: { at: number; from: number; to: number };
}

interface Saved {
  settings: SwapSettings;
  returnTo?: number;
  lastAuto?: SwapView['lastAuto'];
}

export class AccountBank {
  private accounts: SwapAccount[] = [];
  private fetchedAt?: number;
  private lastError?: string;
  private saved: Saved = { settings: { autoApi: false } };
  private refreshing?: Promise<void>;

  constructor(
    private readonly o: { projects: ProjectService; file: string | null; now?: () => number },
  ) {
    this.load();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  view(): SwapView {
    const warn = needsWarning(this.accounts);
    return {
      available: this.o.projects.available(),
      accounts: this.accounts,
      ...(this.fetchedAt ? { fetchedAt: this.fetchedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      settings: { ...this.saved.settings },
      ...(warn ? { warning: { active: warn.number, ...(suggestTarget(this.accounts) ? { suggestion: suggestTarget(this.accounts)!.number } : {}) } } : {}),
      ...(this.saved.lastAuto ? { lastAuto: this.saved.lastAuto } : {}),
    };
  }

  /** Relê a lista (uma de cada vez) e aplica a troca automática para a API, se ligada. Nunca lança. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  /** Atualiza se a lista tem mais de `maxAgeMs` (sem esperar). */
  refreshIfStale(maxAgeMs = 60_000): void {
    if (!this.fetchedAt || this.now() - this.fetchedAt > maxAgeMs) void this.refresh();
  }

  private async doRefresh(): Promise<void> {
    if (!this.o.projects.available()) return;
    try {
      const info = await this.job({ kind: 'swap-list' });
      this.accounts = parseSwapAccounts(info.swap);
      this.fetchedAt = this.now();
      delete this.lastError;
      await this.autoApi();
    } catch (err) {
      this.lastError = errMsg(err);
    }
  }

  private async autoApi(): Promise<void> {
    if (!this.saved.settings.autoApi) return;
    const d = apiFallbackDecision(this.accounts, { returnTo: this.saved.returnTo });
    if (d.action === 'none') return;
    const from = this.accounts.find((a) => a.active)?.number ?? 0;
    await this.job({ kind: 'swap-switch', target: d.target });
    this.saved.returnTo = d.action === 'to-api' ? d.returnTo : undefined;
    this.saved.lastAuto = { at: this.now(), from, to: d.target };
    this.save();
    log.info(d.action === 'to-api' ? tr('Contas: assinatura {0} esgotada; usando a conta de API {1}.', [from, d.target]) : tr('Contas: de volta à assinatura {0}.', [d.target]));
    const info = await this.job({ kind: 'swap-list' });
    this.accounts = parseSwapAccounts(info.swap);
    this.fetchedAt = this.now();
  }

  async switchTo(target: number): Promise<SwapView> {
    if (!this.accounts.some((a) => a.number === target)) throw new Error(tr('conta {0} não está no banco', [target]));
    await this.job({ kind: 'swap-switch', target });
    // Troca manual: a volta automática não vale mais.
    this.saved.returnTo = undefined;
    this.save();
    await this.refresh();
    return this.view();
  }

  async addToken(token: string, label?: string): Promise<SwapView> {
    await this.job({ kind: 'swap-token', token, ...(label ? { label } : {}) });
    await this.refresh();
    return this.view();
  }

  async loginStart(): Promise<{ id: string; url: string }> {
    const info = await this.job({ kind: 'swap-login-start' });
    const login = (info.swap as { login?: { id?: unknown; url?: unknown } } | undefined)?.login;
    if (typeof login?.id !== 'string' || typeof login.url !== 'string' || !/^https:\/\//.test(login.url)) throw new Error(tr('o computador não devolveu o link de login'));
    return { id: login.id, url: login.url };
  }

  async loginFinish(loginId: string, code: string): Promise<{ added?: { number: number; email: string }; view: SwapView }> {
    const info = await this.job({ kind: 'swap-login-finish', loginId, code });
    const added = (info.swap as { added?: { number?: unknown; email?: unknown } } | undefined)?.added;
    await this.refresh();
    return {
      ...(typeof added?.number === 'number' && typeof added.email === 'string' ? { added: { number: added.number, email: added.email } } : {}),
      view: this.view(),
    };
  }

  async loginCancel(loginId: string): Promise<void> {
    await this.job({ kind: 'swap-login-cancel', loginId }).catch(() => undefined);
  }

  setSettings(raw: unknown): SwapView {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (typeof r.autoApi === 'boolean') this.saved.settings.autoApi = r.autoApi;
    this.save();
    if (this.saved.settings.autoApi) void this.refresh();
    return this.view();
  }

  /** Manda um pedido ao computador e espera o resultado; erro vira exceção com o motivo. */
  private async job(body: Record<string, unknown>): Promise<ProjectJobInfo> {
    const r = this.o.projects.submit(body);
    if (!('job' in r)) throw new Error(r.reason);
    const end = this.now() + JOB_WAIT_MS;
    let info = r.job;
    while ((info.status === 'queued' || info.status === 'sent') && this.now() < end) {
      await new Promise((ok) => setTimeout(ok, 300));
      info = this.o.projects.get(info.id) ?? { ...info, status: 'failed', error: tr('pedido perdido') };
    }
    if (info.status !== 'done') throw new Error(info.error ?? tr('o computador não respondeu'));
    return info;
  }

  private load(): void {
    if (!this.o.file) return;
    try {
      const j = JSON.parse(readFileSync(this.o.file, 'utf8')) as Partial<Saved>;
      this.saved = {
        settings: { autoApi: j.settings?.autoApi === true },
        ...(typeof j.returnTo === 'number' ? { returnTo: j.returnTo } : {}),
        ...(j.lastAuto && typeof j.lastAuto.at === 'number' ? { lastAuto: j.lastAuto } : {}),
      };
    } catch {
      // primeira vez
    }
  }

  private save(): void {
    if (!this.o.file) return;
    try {
      mkdirSync(dirname(this.o.file), { recursive: true });
      writeFileSync(`${this.o.file}.tmp`, JSON.stringify(this.saved, null, 2));
      renameSync(`${this.o.file}.tmp`, this.o.file);
    } catch (err) {
      log.warn(tr('Não consegui gravar {0}: {1}', [this.o.file, errMsg(err)]));
    }
  }
}
