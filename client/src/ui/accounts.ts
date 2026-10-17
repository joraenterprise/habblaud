// Contas do Claude (claude-swap; /api/swap; shared/swap.ts): o botão na barra do topo e o modal com o painel de uso de
// cada conta, a troca da conta ativa (um clique de alguém), conectar conta pelo login do Claude (link + código colado),
// cadastrar uma chave de API e a opção de trocar sozinho para a conta de API quando a assinatura esgotar. E o aviso no
// topo quando a conta ativa passa de 90%, sugerindo a com mais folga.
import { isApiAccount, peakPct, WARN_PCT, type SwapAccount } from '../../../shared/swap';
import { tr } from '../../../shared/i18n';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

interface SwapView {
  available: boolean;
  accounts: SwapAccount[];
  fetchedAt?: number;
  lastError?: string;
  settings: { autoApi: boolean };
  warning?: { active: number; suggestion?: number };
  lastAuto?: { at: number; from: number; to: number };
}

const POLL_MS = 60_000;
const DISMISS_KEY = 'habblaud.swap.dismissed';

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
  return j;
}

function untilText(iso?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return tr('agora');
  const min = Math.round(ms / 60_000);
  if (min < 60) return tr('em {0} min', [min]);
  const h2 = Math.floor(min / 60);
  if (h2 < 48) return tr('em {0} h {1} min', [h2, min % 60]);
  return tr('em {0} d', [Math.round(h2 / 24)]);
}

const label = (a: SwapAccount) => a.alias ?? a.email;

export class AccountsPanel implements UiComponent {
  readonly button: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly autoApi: HTMLInputElement;
  private readonly loginBox: HTMLElement;
  private readonly loginLink: HTMLAnchorElement;
  private readonly loginCode: HTMLInputElement;
  private readonly tokenInput: HTMLInputElement;
  private readonly tokenLabel: HTMLInputElement;
  private readonly adminBits: HTMLElement[] = [];
  private readonly banner: HTMLElement;
  private readonly bannerText: HTMLElement;
  private readonly bannerBtn: HTMLButtonElement;
  private view: SwapView | undefined;
  private loginId = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.button = iconButton(ICONS.accounts, tr('Contas do Claude: uso e troca de conta'), () => void this.open(), 'ui-btn-accounts');
    this.button.hidden = true;
    this.list = h('div', { class: 'ui-acc__list' });
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.autoApi = h('input', { type: 'checkbox', attrs: { id: 'ui-acc-auto' } });
    this.autoApi.addEventListener('change', () => void this.act(() => api<SwapView>('/api/swap/settings', 'PUT', { autoApi: this.autoApi.checked })));
    const autoRow = h(
      'label',
      { class: 'ui-proj__check ui-acc__auto', attrs: { for: 'ui-acc-auto' } },
      this.autoApi,
      h('span', { text: tr('Quando a assinatura ativa esgotar, usar sozinho a conta de chave de API (paga por uso) e voltar quando a assinatura tiver folga.') }),
    );
    this.loginLink = h('a', { class: 'ui-btn', attrs: { target: '_blank', rel: 'noopener noreferrer' } }, tr('1. Abrir o login do Claude')) as HTMLAnchorElement;
    this.loginCode = h('input', { class: 'ui-rename__input', type: 'text', attrs: { placeholder: tr('2. Cole aqui o código que o Claude mostrou'), autocomplete: 'off', spellcheck: 'false' } });
    const finish = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.finishLogin() } }, tr('3. Concluir'));
    const cancel = h('button', { class: 'ui-btn', type: 'button', on: { click: () => void this.cancelLogin() } }, tr('Cancelar'));
    this.loginBox = h(
      'div',
      { class: 'ui-acc__login', hidden: true },
      h('p', { class: 'ui-rename__hint', text: tr('Entre no navegador com a conta que vai para o banco. O login acontece numa pasta separada: a conta ativa e os agentes rodando não mudam.') }),
      this.loginLink,
      this.loginCode,
      h('div', { class: 'ui-agents__actions' }, cancel, finish),
    );
    const connect = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.startLogin() } }, tr('+ Conectar conta'));
    this.tokenInput = h('input', { class: 'ui-rename__input', type: 'password', attrs: { placeholder: 'sk-ant-api03-…', autocomplete: 'off' } });
    this.tokenLabel = h('input', { class: 'ui-rename__input', type: 'text', attrs: { placeholder: tr('Nome (opcional), ex.: api-empresa'), autocomplete: 'off' } });
    const addToken = h('button', { class: 'ui-btn', type: 'button', on: { click: () => void this.addToken() } }, tr('Adicionar chave de API'));
    for (const i of [this.loginCode, this.tokenInput, this.tokenLabel]) {
      i.addEventListener('keydown', (e) => e.stopPropagation());
      i.addEventListener('keyup', (e) => e.stopPropagation());
    }
    const tokenBox = h('details', { class: 'ui-acc__token' }, h('summary', { text: tr('Chave de API (Console)') }), h('div', { class: 'ui-agents__row' }, this.tokenInput, this.tokenLabel), addToken);
    const admin = h('div', { class: 'ui-acc__admin' }, h('div', { class: 'ui-agents__actions' }, connect), this.loginBox, tokenBox, autoRow);
    this.adminBits.push(admin);
    const refresh = h('button', { class: 'ui-btn', type: 'button', on: { click: () => void this.act(() => api<SwapView>('/api/swap/refresh', 'POST', {})) } }, tr('Atualizar'));
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.dialog.close(), 'ui-icon-btn--sm');
    this.dialog = h(
      'dialog',
      { class: 'ui-dialog ui-acc', attrs: { 'aria-label': tr('Contas do Claude') } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Contas do Claude') }), h('div', { class: 'ui-agents__actions' }, refresh, close)),
      h('div', { class: 'ui-acc__body' }, this.list, this.status, admin),
    ) as HTMLDialogElement;
    this.bannerText = h('span');
    this.bannerBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button' }, tr('Trocar'));
    const dismiss = iconButton(ICONS.close, tr('Dispensar'), () => this.dismiss(), 'ui-icon-btn--sm');
    this.banner = h('div', { class: 'ui-acc-banner', hidden: true, attrs: { role: 'status' } }, this.bannerText, this.bannerBtn, dismiss);
    ctx.root.append(this.dialog, this.banner);
  }

  render(): void {
    const can = access().spawn && !this.ctx.store.mock && !this.ctx.store.replaying;
    setHidden(this.button, !can);
    if (can && !this.timer) {
      void this.load();
      this.timer = setInterval(() => void this.load(), POLL_MS);
    } else if (!can && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private isAdmin(): boolean {
    const u = access().user;
    return !u || u.role === 'admin';
  }

  private async load(): Promise<void> {
    try {
      this.view = await api<SwapView>('/api/swap');
      this.paint();
    } catch {
      // sem banco de contas: o botão fica, o modal diz o motivo ao abrir
    }
  }

  private async open(): Promise<void> {
    if (!this.dialog.open) this.dialog.showModal();
    this.say(tr('Carregando…'));
    await this.load();
    this.say(this.view?.lastError ? tr('Último erro: {0}', [this.view.lastError]) : '');
  }

  private paint(): void {
    const v = this.view;
    if (!v) return;
    for (const el of this.adminBits) setHidden(el, !this.isAdmin());
    this.autoApi.checked = v.settings.autoApi;
    this.button.classList.toggle('has-warning', !!v.warning);
    if (!v.accounts.length) {
      this.list.replaceChildren(h('p', { class: 'ui-rename__hint', text: v.available ? tr('Nenhuma conta no banco ainda. Conecte a primeira (ou rode cswap add no computador).') : tr('O computador dos agentes não está conectado (npm run codex:bridge).') }));
    } else this.list.replaceChildren(...v.accounts.map((a) => this.row(a)));
    this.paintBanner();
  }

  private bar(title: string, w?: { pct: number; resetsAt?: string }): HTMLElement {
    if (!w) return h('div', { class: 'ui-acc__bar is-empty' });
    const pct = Math.min(100, Math.round(w.pct));
    const fill = h('span', { class: `ui-acc__fill${pct >= 100 ? ' is-full' : pct >= WARN_PCT ? ' is-warn' : ''}` });
    fill.style.width = `${pct}%`;
    return h('div', { class: 'ui-acc__bar', attrs: { title: `${title}: ${pct}%` } }, h('span', { class: 'ui-acc__bar-label', text: `${title} ${pct}%` }), h('span', { class: 'ui-acc__track' }, fill), h('span', { class: 'ui-acc__reset', text: w.resetsAt ? untilText(w.resetsAt) : '' }));
  }

  private row(a: SwapAccount): HTMLElement {
    const api2 = isApiAccount(a);
    const badges = [a.active ? tr('ativa') : '', api2 ? tr('chave de API') : '', a.disabled ? tr('desativada') : '', a.status === 'token_expired' || a.status === 'relogin_required' ? tr('login vencido') : ''].filter(Boolean);
    const use = h(
      'button',
      {
        class: 'ui-btn ui-perm__btn ui-perm__btn--allow',
        type: 'button',
        hidden: a.active || !this.isAdmin(),
        on: {
          click: () => {
            if (confirm(tr('Trocar a conta ativa para {0}? Os agentes rodando passam a usar essa conta na próxima mensagem.', [label(a)]))) void this.act(() => api<SwapView>('/api/swap/switch', 'POST', { target: a.number }));
          },
        },
      },
      tr('Usar esta conta'),
    );
    return h(
      'div',
      { class: `ui-acc__row${a.active ? ' is-active' : ''}` },
      h('span', { class: 'ui-acc__num', text: String(a.number) }),
      h(
        'div',
        { class: 'ui-acc__info' },
        h('strong', { text: label(a) }),
        h('span', { class: 'ui-acc__meta', text: [a.organization, ...badges].filter(Boolean).join(' · ') }),
        api2 ? h('span', { class: 'ui-acc__meta', text: tr('Sem cota de assinatura: cobra pelo uso.') }) : h('div', { class: 'ui-acc__bars' }, this.bar(tr('5 h'), a.fiveHour), this.bar(tr('7 dias'), a.sevenDay)),
      ),
      use,
    );
  }

  private paintBanner(): void {
    const v = this.view;
    const w = v?.warning;
    const active = w && v.accounts.find((a) => a.number === w.active);
    const target = w?.suggestion !== undefined ? v!.accounts.find((a) => a.number === w.suggestion) : undefined;
    const key = active ? `${active.number}:${Math.floor((peakPct(active) ?? 0) / 5)}` : '';
    let dismissed = '';
    try {
      dismissed = sessionStorage.getItem(DISMISS_KEY) ?? '';
    } catch {
      // sem armazenamento
    }
    const show = !!active && dismissed !== key;
    setHidden(this.banner, !show);
    if (!show || !active) return;
    const pct = Math.round(peakPct(active) ?? 0);
    setText(
      this.bannerText,
      target
        ? tr('A conta {0} está em {1}% do limite. A {2} tem mais folga ({3}%).', [label(active), pct, label(target), Math.round(peakPct(target) ?? 0)])
        : tr('A conta {0} está em {1}% do limite e nenhuma outra assinatura tem folga agora.', [label(active), pct]),
    );
    setHidden(this.bannerBtn, !target || !this.isAdmin());
    this.bannerBtn.onclick = () => {
      if (target) void this.act(() => api<SwapView>('/api/swap/switch', 'POST', { target: target.number }));
    };
    this.banner.dataset.key = key;
  }

  private dismiss(): void {
    try {
      sessionStorage.setItem(DISMISS_KEY, this.banner.dataset.key ?? '');
    } catch {
      // sem armazenamento
    }
    setHidden(this.banner, true);
  }

  private async act(fn: () => Promise<SwapView>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say(tr('Falando com o computador…'));
    try {
      this.view = await fn();
      this.paint();
      this.say('');
      this.ctx.announce(tr('Contas atualizadas.'));
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  private async startLogin(): Promise<void> {
    this.say(tr('Preparando o login…'));
    try {
      const r = await api<{ id: string; url: string }>('/api/swap/login/start', 'POST', {});
      this.loginId = r.id;
      this.loginLink.href = r.url;
      this.loginCode.value = '';
      setHidden(this.loginBox, false);
      this.say('');
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private async finishLogin(): Promise<void> {
    if (!this.loginId) return;
    this.say(tr('Concluindo o login e guardando a conta…'));
    try {
      const r = await api<{ added?: { number: number; email: string }; view: SwapView }>('/api/swap/login/finish', 'POST', { loginId: this.loginId, code: this.loginCode.value });
      this.loginId = '';
      this.loginCode.value = '';
      setHidden(this.loginBox, true);
      this.view = r.view;
      this.paint();
      this.say(r.added ? tr('Conta {0} ({1}) no banco.', [r.added.number, r.added.email]) : tr('Conta guardada.'));
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private async cancelLogin(): Promise<void> {
    const id = this.loginId;
    this.loginId = '';
    setHidden(this.loginBox, true);
    if (id) await api('/api/swap/login/cancel', 'POST', { loginId: id }).catch(() => undefined);
    this.say('');
  }

  private async addToken(): Promise<void> {
    const token = this.tokenInput.value.trim();
    if (!token) return;
    const label2 = this.tokenLabel.value.trim();
    this.tokenInput.value = '';
    await this.act(() => api<SwapView>('/api/swap/token', 'POST', { token, ...(label2 ? { label: label2 } : {}) }));
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}
