// Login por pessoa (HABBLAUD_LOGIN=1; server/auth/): o botão com o nome de quem está logado na barra do topo e o menu
// dele (trocar a própria senha, Usuários para administradores, Sair), e o modal de gestão de usuários (criar, mudar
// papel, redefinir senha, desativar, apagar). Aparece só quando o servidor diz quem está logado (/api/access).
import { tr } from '../../../shared/i18n';
import type { AccessInfo } from '../../../shared/types';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

type Me = NonNullable<AccessInfo['user']>;
interface UserRow {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'member';
  disabled?: boolean;
  createdAt: number;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && path !== '/api/auth/password') location.assign('/login');
  if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
  return j;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export class UserMenu implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private readonly dialog: HTMLDialogElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly menuName: HTMLElement;
  private readonly menuRole: HTMLElement;
  private readonly usersBtn: HTMLButtonElement;
  private me: Me | undefined;

  constructor(private readonly ctx: UiContext) {
    this.button = h('button', { class: 'ui-user-chip', type: 'button', hidden: true, attrs: { 'aria-haspopup': 'menu' }, on: { click: () => this.toggleMenu() } });
    this.menuName = h('strong');
    this.menuRole = h('span', { class: 'ui-user-menu__role' });
    this.usersBtn = h('button', { class: 'ui-user-menu__item', type: 'button', on: { click: () => this.openUsers() } }, tr('Usuários'));
    this.el = h(
      'div',
      { class: 'ui-popover ui-user-menu', attrs: { popover: 'auto', role: 'menu' } },
      h('div', { class: 'ui-user-menu__head' }, this.menuName, this.menuRole),
      h('button', { class: 'ui-user-menu__item', type: 'button', on: { click: () => void this.changeOwnPassword() } }, tr('Trocar minha senha')),
      this.usersBtn,
      h('button', { class: 'ui-user-menu__item is-danger', type: 'button', on: { click: () => void this.logout() } }, tr('Sair')),
    );
    this.list = h('div', { class: 'ui-users__list' });
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const field = (id: string, label: string, input: HTMLElement) => h('div', { class: 'ui-users__field' }, h('label', { class: 'ui-spawn__label', attrs: { for: id }, text: label }), input);
    const nu = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-nu-user', autocomplete: 'off', spellcheck: 'false', placeholder: 'maria' } });
    const nn = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-nu-name', autocomplete: 'off', placeholder: 'Maria Silva' } });
    const np = h('input', { class: 'ui-rename__input', type: 'password', attrs: { id: 'ui-nu-pass', autocomplete: 'new-password' } });
    const nr = h('select', { class: 'ui-rename__input', attrs: { id: 'ui-nu-role' } }, h('option', { attrs: { value: 'member' } }, tr('Membro')), h('option', { attrs: { value: 'admin' } }, tr('Administrador')));
    const add = h(
      'button',
      {
        class: 'ui-btn ui-perm__btn ui-perm__btn--allow',
        type: 'button',
        on: {
          click: async () => {
            try {
              await api('/api/users', 'POST', { username: nu.value, name: nn.value, password: np.value, role: nr.value });
              nu.value = nn.value = np.value = '';
              this.say(tr('Usuário criado.'));
              await this.loadUsers();
            } catch (err) {
              this.say((err as Error).message, true);
            }
          },
        },
      },
      tr('Criar usuário'),
    );
    for (const i of [nu, nn, np]) {
      i.addEventListener('keydown', (e) => e.stopPropagation());
      i.addEventListener('keyup', (e) => e.stopPropagation());
    }
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.dialog.close(), 'ui-icon-btn--sm');
    this.dialog = h(
      'dialog',
      { class: 'ui-dialog ui-users', attrs: { 'aria-label': tr('Usuários') } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: tr('Usuários') }), close),
      h(
        'div',
        { class: 'ui-users__body' },
        this.list,
        h('h3', { class: 'ui-users__sub', text: tr('Novo usuário') }),
        h('div', { class: 'ui-users__form' }, field('ui-nu-user', tr('Usuário'), nu), field('ui-nu-name', tr('Nome'), nn), field('ui-nu-pass', tr('Senha (mín. 8)'), np), field('ui-nu-role', tr('Papel'), nr)),
        add,
        this.status,
      ),
    ) as HTMLDialogElement;
    ctx.root.append(this.el, this.dialog);
  }

  render(): void {
    const me = access().user;
    this.me = me;
    setHidden(this.button, !me);
    if (!me) return;
    setText(this.button, initials(me.name));
    this.button.title = tr('{0} ({1})', [me.name, me.username]);
    setText(this.menuName, me.name);
    setText(this.menuRole, me.role === 'admin' ? tr('administrador') : tr('membro'));
    setHidden(this.usersBtn, me.role !== 'admin');
  }

  private toggleMenu(): void {
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right))}px`;
    try {
      this.el.togglePopover();
    } catch {
      this.el.classList.toggle('is-open');
    }
  }

  private async logout(): Promise<void> {
    try {
      await api('/api/auth/logout', 'POST', {});
    } finally {
      location.assign('/login');
    }
  }

  private async changeOwnPassword(): Promise<void> {
    const current = prompt(tr('Senha atual'));
    if (!current) return;
    const next = prompt(tr('Nova senha (mínimo 8 caracteres)'));
    if (!next) return;
    try {
      await api('/api/auth/password', 'POST', { current, password: next });
      this.ctx.announce(tr('Senha trocada.'));
      alert(tr('Senha trocada.'));
    } catch (err) {
      alert((err as Error).message);
    }
  }

  private async openUsers(): Promise<void> {
    try {
      this.el.hidePopover();
    } catch {
      // sem popover
    }
    this.say('');
    if (!this.dialog.open) this.dialog.showModal();
    await this.loadUsers();
  }

  private async loadUsers(): Promise<void> {
    try {
      const { users } = await api<{ users: UserRow[] }>('/api/users');
      this.list.replaceChildren(...users.map((u) => this.row(u)));
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private row(u: UserRow): HTMLElement {
    const act = (label: string, fn: () => Promise<unknown>, danger = false) =>
      h(
        'button',
        {
          class: `ui-btn${danger ? ' ui-agents__delete' : ''}`,
          type: 'button',
          on: {
            click: async () => {
              try {
                await fn();
                await this.loadUsers();
              } catch (err) {
                this.say((err as Error).message, true);
              }
            },
          },
        },
        label,
      );
    const self = u.id === this.me?.id;
    return h(
      'div',
      { class: `ui-users__row${u.disabled ? ' is-off' : ''}` },
      h('span', { class: 'ui-user-chip is-static', text: initials(u.name) }),
      h(
        'div',
        { class: 'ui-users__who' },
        h('strong', { text: `${u.name}${self ? tr(' (você)') : ''}` }),
        h('span', { class: 'ui-users__meta', text: `${u.username} · ${u.role === 'admin' ? tr('administrador') : tr('membro')}${u.disabled ? tr(' · desativado') : ''}` }),
      ),
      h(
        'div',
        { class: 'ui-users__actions' },
        act(u.role === 'admin' ? tr('Tornar membro') : tr('Tornar admin'), () => api(`/api/users/${encodeURIComponent(u.id)}`, 'PUT', { role: u.role === 'admin' ? 'member' : 'admin' })),
        act(tr('Nova senha'), async () => {
          const p = prompt(tr('Nova senha para {0} (mínimo 8 caracteres)', [u.username]));
          if (p) await api(`/api/users/${encodeURIComponent(u.id)}`, 'PUT', { password: p });
        }),
        self ? null : act(u.disabled ? tr('Ativar') : tr('Desativar'), () => api(`/api/users/${encodeURIComponent(u.id)}`, 'PUT', { disabled: !u.disabled })),
        self
          ? null
          : act(
              tr('Apagar'),
              async () => {
                if (confirm(tr('Apagar o usuário {0}?', [u.username]))) await api(`/api/users/${encodeURIComponent(u.id)}`, 'DELETE');
              },
              true,
            ),
      ),
    );
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}
