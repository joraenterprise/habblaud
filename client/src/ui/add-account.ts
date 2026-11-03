// "Adicionar conta" (claude-swap): tela de configuração em três passos, no centro da tela.
// 1. Tipo: assinatura do Claude (Pro, Max, Team: login no navegador) ou chave de API do Console (paga pelo uso).
// 2. Conectar: assinatura = abrir o login do Claude e colar o código (o login acontece numa pasta separada: a conta
//    ativa e os agentes rodando não mudam); chave = colar a chave (vai pelo stdin do cswap, nunca fica guardada aqui).
// 3. Pronto: apelido (cswap alias) e, se quiser, usar a conta agora (cswap switch).
// Fala com /api/swap/* (server/accounts/bank.ts); quem roda o cswap é o computador dos agentes.
import { tr } from '../../../shared/i18n';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

type Step = 'type' | 'login' | 'token' | 'done';

interface Added {
  number: number;
  email: string;
}

async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
  return j;
}

/** Apelido sugerido a partir do e-mail ("maria.silva@x.com" -> "maria.silva"). */
export function aliasFromEmail(email: string): string {
  const base = (email.split('@')[0] ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return base.slice(0, 32) || 'conta';
}

export class AddAccountDialog {
  readonly el: HTMLDialogElement;
  private step: Step = 'type';
  private readonly steps: HTMLElement[];
  private readonly panes: Record<Step, HTMLElement>;
  private readonly status: HTMLElement;
  private readonly openLogin: HTMLAnchorElement;
  private readonly code: HTMLInputElement;
  private readonly token: HTMLInputElement;
  private readonly tokenName: HTMLInputElement;
  private readonly tokenLead: HTMLElement;
  private readonly doneTitle: HTMLElement;
  private readonly alias: HTMLInputElement;
  private readonly useNow: HTMLInputElement;
  private loginId = '';
  private added: Added | undefined;
  private busy = false;

  constructor(
    root: HTMLElement,
    /** Depois de adicionar (ou mudar algo), para a tela Contas se atualizar. */
    private readonly onChanged: () => void,
  ) {
    const stepEl = (n: number, label: string) => h('li', { class: 'ui-add__step' }, h('span', { class: 'ui-add__dot', text: String(n) }), h('span', { text: label }));
    this.steps = [stepEl(1, tr('Tipo')), stepEl(2, tr('Conectar')), stepEl(3, tr('Pronto'))];

    // 1. Tipo
    const choice = (title: string, desc: string, onClick: () => void) =>
      h('button', { class: 'ui-add__choice', type: 'button', on: { click: onClick } }, h('strong', { text: title }), h('span', { text: desc }));
    const typePane = h(
      'div',
      { class: 'ui-add__pane' },
      h('p', { class: 'ui-add__lead', text: tr('Que tipo de conta você quer pôr no banco?') }),
      h(
        'div',
        { class: 'ui-add__choices' },
        choice(tr('Assinatura do Claude'), tr('Pro, Max ou assento do Team. Você entra com a conta no navegador e cola o código.'), () => void this.startLogin()),
        choice(tr('Login de 1 ano (recomendado)'), tr('Token da assinatura gerado com claude setup-token. Não vence nem cai quando alguém entra com outra conta.'), () => this.tokenMode('oat')),
        choice(tr('Chave de API (Console)'), tr('Uma chave sk-ant-… do Console. Sem cota de assinatura: cobra pelo uso.'), () => this.tokenMode('api')),
      ),
    );

    // 2a. Login da assinatura
    this.openLogin = h('a', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-add__open', attrs: { target: '_blank', rel: 'noopener noreferrer' } }, tr('Abrir o login do Claude')) as HTMLAnchorElement;
    this.code = h('input', { class: 'ui-rename__input ui-add__code', type: 'text', attrs: { placeholder: tr('Cole aqui o código'), autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('Código do login do Claude') } });
    const loginPane = h(
      'div',
      { class: 'ui-add__pane' },
      h(
        'ol',
        { class: 'ui-add__howto' },
        h('li', {}, h('span', { text: tr('Abra o login e entre com a conta que vai para o banco (de preferência numa janela anônima, se o navegador já estiver logado em outra conta do Claude).') })),
        h('li', {}, h('span', { text: tr('Autorize. O Claude mostra um código.') })),
        h('li', {}, h('span', { text: tr('Copie o código, cole abaixo e clique em Conectar.') })),
      ),
      this.openLogin,
      this.code,
      h('p', { class: 'ui-rename__hint', text: tr('O login acontece numa pasta separada no computador: a conta ativa e os agentes que estão rodando não mudam.') }),
      h('div', { class: 'ui-add__actions' }, h('button', { class: 'ui-btn', type: 'button', on: { click: () => void this.back() } }, tr('Voltar')), h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.finishLogin() } }, tr('Conectar'))),
    );

    // 2b. Chave de API
    this.token = h('input', { class: 'ui-rename__input', type: 'password', attrs: { placeholder: 'sk-ant-api03-…', autocomplete: 'off', 'aria-label': tr('Chave de API') } });
    this.tokenName = h('input', { class: 'ui-rename__input', type: 'text', attrs: { placeholder: tr('Nome da conta (opcional), ex.: api-empresa'), autocomplete: 'off' } });
    this.tokenLead = h('div', { class: 'ui-add__pane' });
    this.setTokenKind('api');
    const tokenPane = h(
      'div',
      { class: 'ui-add__pane' },
      this.tokenLead,
      this.token,
      this.tokenName,
      h('p', { class: 'ui-rename__hint', text: tr('A chave vai direto para o claude-swap do computador e não fica guardada no Habblaud.') }),
      h('div', { class: 'ui-add__actions' }, h('button', { class: 'ui-btn', type: 'button', on: { click: () => this.go('type') } }, tr('Voltar')), h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.addToken() } }, tr('Adicionar'))),
    );

    // 3. Pronto
    this.doneTitle = h('p', { class: 'ui-add__lead' });
    this.alias = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 32, autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('Apelido') } });
    this.useNow = h('input', { type: 'checkbox', attrs: { id: 'ui-add-use' } });
    const donePane = h(
      'div',
      { class: 'ui-add__pane' },
      h('div', { class: 'ui-add__ok', attrs: { 'aria-hidden': 'true' }, text: '✓' }),
      this.doneTitle,
      h('label', { class: 'ui-spawn__label', text: tr('Apelido (aparece na tela Contas)') }),
      this.alias,
      h('label', { class: 'ui-proj__check', attrs: { for: 'ui-add-use' } }, this.useNow, h('span', { text: tr('Usar esta conta agora (os agentes rodando passam a usá-la na próxima mensagem)') })),
      h('div', { class: 'ui-add__actions' }, h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.finish() } }, tr('Concluir'))),
    );

    this.panes = { type: typePane, login: loginPane, token: tokenPane, done: donePane };
    for (const i of [this.code, this.token, this.tokenName, this.alias]) {
      i.addEventListener('keydown', (e) => e.stopPropagation());
      i.addEventListener('keyup', (e) => e.stopPropagation());
    }
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const close = iconButton(ICONS.close, tr('Fechar'), () => void this.close(), 'ui-icon-btn--sm');
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-add', attrs: { 'aria-label': tr('Adicionar conta') } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Adicionar conta do Claude') }), close),
      h('div', { class: 'ui-add__body' }, h('ol', { class: 'ui-add__steps' }, ...this.steps), typePane, loginPane, tokenPane, donePane, this.status),
    ) as HTMLDialogElement;
    this.el.addEventListener('cancel', (e) => {
      e.preventDefault();
      void this.close();
    });
    root.append(this.el);
  }

  open(): void {
    this.added = undefined;
    this.loginId = '';
    this.code.value = this.token.value = this.tokenName.value = this.alias.value = '';
    this.useNow.checked = false;
    this.go('type');
    if (!this.el.open) this.el.showModal();
  }

  /** O passo da chave serve para os dois tipos: token de 1 ano da assinatura (setup-token) ou chave de API. */
  private tokenMode(kind: 'oat' | 'api'): void {
    this.setTokenKind(kind);
    this.go('token');
  }

  private setTokenKind(kind: 'oat' | 'api'): void {
    if (kind === 'oat') {
      this.tokenLead.replaceChildren(
        h('p', { class: 'ui-add__lead', text: tr('Gere um login de 1 ano da assinatura e cole aqui.') }),
        h(
          'ol',
          { class: 'ui-add__howto' },
          h('li', {}, h('span', { text: tr('Num terminal do computador, rode: claude setup-token') })),
          h('li', {}, h('span', { text: tr('Entre no navegador com a conta que vai para o banco e autorize.') })),
          h('li', {}, h('span', { text: tr('O terminal mostra um token sk-ant-oat01-…: copie e cole abaixo.') })),
        ),
        h('p', { class: 'ui-rename__hint', text: tr('Vale por 1 ano e não depende do login do Claude Code: não vence a cada poucas horas nem cai quando alguém entra com outra conta. Só serve para rodar agentes (a tela Contas não mostra o uso dele).') }),
      );
      this.token.placeholder = 'sk-ant-oat01-…';
      this.token.setAttribute('aria-label', tr('Token de 1 ano'));
    } else {
      this.tokenLead.replaceChildren(h('p', { class: 'ui-add__lead', text: tr('Cole a chave de API do Console (crie uma chave de um workspace só).') }));
      this.token.placeholder = 'sk-ant-api03-…';
      this.token.setAttribute('aria-label', tr('Chave de API'));
    }
  }

  private go(step: Step): void {
    this.step = step;
    for (const [k, pane] of Object.entries(this.panes)) setHidden(pane, k !== step);
    const index = step === 'type' ? 0 : step === 'done' ? 2 : 1;
    this.steps.forEach((s, i) => {
      s.classList.toggle('is-on', i === index);
      s.classList.toggle('is-done', i < index);
    });
    this.say('');
    if (step === 'login') this.code.focus();
    if (step === 'token') this.token.focus();
  }

  private async startLogin(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say(tr('Preparando o login no computador…'));
    try {
      const r = await api<{ id: string; url: string }>('/api/swap/login/start', {});
      this.loginId = r.id;
      this.openLogin.href = r.url;
      this.go('login');
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  /** Do login de volta à escolha do tipo: o login começado no computador é cancelado. */
  private async back(): Promise<void> {
    if (this.loginId) await api('/api/swap/login/cancel', { loginId: this.loginId }).catch(() => undefined);
    this.loginId = '';
    this.go('type');
  }

  private async finishLogin(): Promise<void> {
    if (this.busy || !this.loginId) return;
    if (!this.code.value.trim()) return this.say(tr('Cole o código que o Claude mostrou.'), true);
    this.busy = true;
    this.say(tr('Conectando a conta…'));
    try {
      const r = await api<{ added?: Added }>('/api/swap/login/finish', { loginId: this.loginId, code: this.code.value });
      this.loginId = '';
      this.done(r.added);
    } catch (err) {
      // O login no computador terminou (deu certo ou não): para tentar de novo, um link novo.
      this.loginId = '';
      this.say(tr('{0} Volte e gere um link novo.', [(err as Error).message]), true);
    } finally {
      this.busy = false;
    }
  }

  private async addToken(): Promise<void> {
    if (this.busy) return;
    const token = this.token.value.trim();
    if (!token) return this.say(tr('Cole a chave de API.'), true);
    this.busy = true;
    this.say(tr('Adicionando a chave…'));
    try {
      const name = this.tokenName.value.trim();
      const r = await api<{ added?: Added }>('/api/swap/token', { token, ...(name ? { label: name } : {}) });
      this.token.value = '';
      this.done(r.added);
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  private done(added: Added | undefined): void {
    this.added = added;
    this.onChanged();
    setText(this.doneTitle, added ? tr('Conta {0} adicionada: {1}', [added.number, added.email]) : tr('Conta adicionada ao banco.'));
    this.alias.value = added ? aliasFromEmail(added.email) : '';
    setHidden(this.alias, !added);
    this.go('done');
  }

  private async finish(): Promise<void> {
    const a = this.added;
    if (a && !this.busy) {
      this.busy = true;
      try {
        const name = this.alias.value.trim();
        if (name && name !== a.email) await api('/api/swap/alias', { target: a.number, name });
        if (this.useNow.checked) await api('/api/swap/switch', { target: a.number });
      } catch (err) {
        this.busy = false;
        return this.say((err as Error).message, true);
      }
      this.busy = false;
    }
    this.onChanged();
    this.el.close();
  }

  private async close(): Promise<void> {
    // Login começado e não terminado: encerra o processo e apaga a pasta temporária no computador.
    if (this.loginId) await api('/api/swap/login/cancel', { loginId: this.loginId }).catch(() => undefined);
    this.loginId = '';
    if (this.el.open) this.el.close();
    if (this.added) this.onChanged();
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}
