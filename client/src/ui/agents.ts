// Agentes personalizados (botão na barra do topo): lista, cria, edita e apaga os papéis salvos no Habblaud
// (/api/custom-agents; shared/custom-agents.ts). "Usar" abre o Novo agente já com o agente escolhido (ui/spawn.ts),
// que começa a sessão com `claude --agents <json> --agent <id>`. A skill /criar-agente do mod monta um agente
// conversando no Claude Code e salva pela mesma rota.
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_MODELS,
  AGENT_NAME_MAX,
  AGENT_PERMISSION_MODES,
  AGENT_PROMPT_MAX,
  COMMON_TOOLS,
  agentSlug,
  type CustomAgent,
  type CustomAgentInput,
} from '../../../shared/custom-agents';
import { tr } from '../../../shared/i18n';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { shortPath } from './spawn';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
  return body;
}

/** Lista do servidor (vazia se o recurso estiver desligado ou fora do ar). */
export async function fetchCustomAgents(): Promise<CustomAgent[]> {
  try {
    const r = await api<{ agents: CustomAgent[] }>('/api/custom-agents');
    return Array.isArray(r.agents) ? r.agents : [];
  } catch {
    return [];
  }
}

function modelLabel(m: string): string {
  if (!m) return tr('Padrão da conta');
  return m.charAt(0).toUpperCase() + m.slice(1);
}

function permissionLabel(m: string): string {
  switch (m) {
    case 'default':
      return tr('Perguntar tudo');
    case 'acceptEdits':
      return tr('Aceitar edições');
    case 'plan':
      return tr('Só planejar');
    default:
      return tr('Padrão da conta');
  }
}

const stop = (field: HTMLElement) => {
  field.addEventListener('keydown', (e) => e.stopPropagation());
  field.addEventListener('keyup', (e) => e.stopPropagation());
};

export class AgentsPanel {
  readonly el: HTMLElement;
  private readonly listView: HTMLElement;
  private readonly list: HTMLElement;
  private readonly formView: HTMLElement;
  private readonly formTitle: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly idHint: HTMLElement;
  private readonly description: HTMLTextAreaElement;
  private readonly prompt: HTMLTextAreaElement;
  private readonly model: HTMLSelectElement;
  private readonly modelOther: HTMLInputElement;
  private readonly permission: HTMLSelectElement;
  private readonly toolChips: HTMLElement;
  private readonly toolsExtra: HTMLInputElement;
  private readonly folder: HTMLInputElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly deleteBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private anchor?: HTMLElement;
  private agents: CustomAgent[] = [];
  private editing: CustomAgent | null = null;
  private tools = new Set<string>();
  private busy = false;

  constructor(
    private readonly ctx: UiContext,
    /** "Usar": abre o Novo agente com este agente. */
    private readonly onUse: (id: string) => void,
  ) {
    this.list = h('div', { class: 'ui-agents__list', role: 'list' });
    const newBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-agents__new', type: 'button', on: { click: () => this.edit(null) } }, tr('+ Criar agente'));
    this.listView = h(
      'div',
      { class: 'ui-set-group ui-agents__view' },
      this.list,
      newBtn,
      h('p', { class: 'ui-rename__hint', text: tr('Cada agente é um papel com instruções próprias. "Usar" começa uma sessão do Claude Code já como ele. Para montar um conversando, rode /criar-agente no Claude Code.') }),
    );

    this.formTitle = h('h3', { class: 'ui-agents__title' });
    this.name = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-agent-name', maxlength: AGENT_NAME_MAX, placeholder: tr('Ex.: Revisor de código'), autocomplete: 'off' } });
    this.idHint = h('p', { class: 'ui-agents__id' });
    this.name.addEventListener('input', () => this.renderId());
    this.description = h('textarea', {
      class: 'ui-rename__input ui-agents__desc',
      attrs: { id: 'ui-agent-desc', rows: 2, maxlength: AGENT_DESCRIPTION_MAX, placeholder: tr('Quando usar: ex.: revisa diffs procurando bugs e riscos de segurança') },
    });
    this.prompt = h('textarea', {
      class: 'ui-rename__input ui-spawn__prompt ui-agents__prompt',
      attrs: { id: 'ui-agent-prompt', rows: 8, maxlength: AGENT_PROMPT_MAX, placeholder: tr('Instruções: quem o agente é, como trabalha, o que entrega e o que evita.') },
    });
    this.model = h('select', { class: 'ui-rename__input', attrs: { id: 'ui-agent-model' } });
    for (const m of [...AGENT_MODELS, '*']) this.model.append(h('option', { attrs: { value: m } }, m === '*' ? tr('Outro…') : modelLabel(m)));
    this.modelOther = h('input', { class: 'ui-rename__input ui-agents__model-other', type: 'text', hidden: true, attrs: { placeholder: 'claude-opus-5-5', autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('Nome do modelo') } });
    this.model.addEventListener('change', () => setHidden(this.modelOther, this.model.value !== '*'));
    this.permission = h('select', { class: 'ui-rename__input', attrs: { id: 'ui-agent-perm' } });
    for (const m of AGENT_PERMISSION_MODES) this.permission.append(h('option', { attrs: { value: m } }, permissionLabel(m)));
    this.toolChips = h('div', { class: 'ui-agents__tools', role: 'group', attrs: { 'aria-label': tr('Ferramentas') } });
    this.toolsExtra = h('input', { class: 'ui-rename__input', type: 'text', attrs: { placeholder: tr('Outras, separadas por vírgula (ex.: Bash(git:*), mcp__github)'), autocomplete: 'off', spellcheck: 'false', 'aria-label': tr('Outras ferramentas') } });
    this.folder = h('input', { class: 'ui-rename__input', type: 'text', attrs: { id: 'ui-agent-folder', placeholder: tr('Opcional: C:\\Users\\voce\\projeto'), autocomplete: 'off', spellcheck: 'false' } });
    for (const f of [this.name, this.description, this.prompt, this.modelOther, this.toolsExtra, this.folder]) stop(f);
    this.saveBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-agents__save', type: 'button', on: { click: () => void this.save() } }, tr('Salvar'));
    this.deleteBtn = h('button', { class: 'ui-btn ui-agents__delete', type: 'button', on: { click: () => void this.remove() } }, tr('Apagar'));
    const back = h('button', { class: 'ui-btn', type: 'button', on: { click: () => this.showList() } }, tr('Voltar'));
    const label = (id: string, text: string) => h('label', { class: 'ui-spawn__label', attrs: { for: id }, text });
    this.formView = h(
      'div',
      { class: 'ui-set-group ui-agents__view', hidden: true },
      this.formTitle,
      label('ui-agent-name', tr('Nome')),
      this.name,
      this.idHint,
      label('ui-agent-desc', tr('Quando usar')),
      this.description,
      label('ui-agent-prompt', tr('Instruções')),
      this.prompt,
      h('div', { class: 'ui-agents__row' }, h('div', {}, label('ui-agent-model', tr('Modelo')), this.model, this.modelOther), h('div', {}, label('ui-agent-perm', tr('Permissões')), this.permission)),
      h('p', { class: 'ui-spawn__label', text: tr('Ferramentas (nenhuma marcada = todas)') }),
      this.toolChips,
      this.toolsExtra,
      label('ui-agent-folder', tr('Pasta sugerida')),
      this.folder,
      h('div', { class: 'ui-agents__actions' }, back, this.deleteBtn, this.saveBtn),
    );
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const close = iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn ui-agents', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Agentes'), id: 'ui-agents', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Agentes') }), close),
      this.listView,
      this.formView,
      h('div', { class: 'ui-agents__foot' }, this.status),
    );
    this.el.addEventListener('toggle', () => this.anchor?.setAttribute('aria-expanded', String(this.isOpen)));
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(anchor: HTMLElement): void {
    this.anchor = anchor;
    if (this.isOpen) return this.hide();
    this.showList();
    void this.load();
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  private async load(): Promise<void> {
    try {
      const r = await api<{ agents: CustomAgent[] }>('/api/custom-agents');
      this.agents = Array.isArray(r.agents) ? r.agents : [];
      this.renderList();
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private renderList(): void {
    if (!this.agents.length) {
      this.list.replaceChildren(h('p', { class: 'ui-agents__empty', text: tr('Nenhum agente ainda.') }));
      return;
    }
    this.list.replaceChildren(
      ...this.agents.map((a) =>
        h(
          'div',
          { class: 'ui-agents__item', role: 'listitem' },
          h(
            'div',
            { class: 'ui-agents__info' },
            h('span', { class: 'ui-spawn__folder-name', text: a.name }),
            h('span', { class: 'ui-agents__desc-line', text: a.description, attrs: { title: a.description } }),
            h(
              'span',
              { class: 'ui-agents__meta' },
              [modelLabel(a.model), a.tools.length ? tr('{0} ferramentas', [a.tools.length]) : tr('todas as ferramentas'), a.folder ? shortPath(a.folder) : ''].filter(Boolean).join(' · '),
            ),
          ),
          h(
            'div',
            { class: 'ui-agents__item-actions' },
            h('button', { class: 'ui-btn', type: 'button', on: { click: () => this.edit(a) } }, tr('Editar')),
            h(
              'button',
              {
                class: 'ui-btn ui-perm__btn ui-perm__btn--allow',
                type: 'button',
                on: {
                  click: () => {
                    this.hide();
                    this.onUse(a.id);
                  },
                },
              },
              tr('Usar'),
            ),
          ),
        ),
      ),
    );
  }

  private showList(): void {
    this.editing = null;
    setHidden(this.formView, true);
    setHidden(this.listView, false);
    this.say('');
    this.renderList();
  }

  private edit(a: CustomAgent | null): void {
    this.editing = a;
    setText(this.formTitle, a ? tr('Editar {0}', [a.name]) : tr('Novo agente personalizado'));
    this.name.value = a?.name ?? '';
    this.description.value = a?.description ?? '';
    this.prompt.value = a?.prompt ?? '';
    const known = (AGENT_MODELS as readonly string[]).includes(a?.model ?? '');
    this.model.value = known ? (a?.model ?? '') : '*';
    this.modelOther.value = known ? '' : (a?.model ?? '');
    setHidden(this.modelOther, known);
    this.permission.value = a?.permissionMode ?? '';
    this.tools = new Set(a?.tools ?? []);
    this.toolsExtra.value = [...this.tools].filter((t) => !(COMMON_TOOLS as readonly string[]).includes(t)).join(', ');
    this.folder.value = a?.folder ?? '';
    setHidden(this.deleteBtn, !a);
    this.renderTools();
    this.renderId();
    this.say('');
    setHidden(this.listView, true);
    setHidden(this.formView, false);
    this.name.focus();
  }

  private renderId(): void {
    const id = this.editing?.id ?? agentSlug(this.name.value);
    setText(this.idHint, id ? tr('No Claude Code: --agent {0}', [id]) : '');
  }

  private renderTools(): void {
    this.toolChips.replaceChildren(
      ...COMMON_TOOLS.map((t) => {
        const on = this.tools.has(t);
        return h(
          'button',
          {
            class: `ui-agents__tool${on ? ' is-on' : ''}`,
            type: 'button',
            attrs: { 'aria-pressed': String(on) },
            on: {
              click: () => {
                if (this.tools.has(t)) this.tools.delete(t);
                else this.tools.add(t);
                this.renderTools();
              },
            },
          },
          t,
        );
      }),
    );
  }

  private input(): Partial<CustomAgentInput> {
    const extra = this.toolsExtra.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const common = [...this.tools].filter((t) => (COMMON_TOOLS as readonly string[]).includes(t));
    return {
      name: this.name.value,
      description: this.description.value,
      prompt: this.prompt.value,
      model: this.model.value === '*' ? this.modelOther.value.trim() : this.model.value,
      permissionMode: this.permission.value as CustomAgentInput['permissionMode'],
      tools: [...common, ...extra],
      folder: this.folder.value.trim(),
    };
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.saveBtn.disabled = true;
    try {
      const editing = this.editing;
      const saved = await api<CustomAgent>(editing ? `/api/custom-agents/${encodeURIComponent(editing.id)}` : '/api/custom-agents', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.input()),
      });
      this.agents = [...this.agents.filter((a) => a.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name));
      this.showList();
      this.say(tr('{0} salvo.', [saved.name]));
      this.ctx.announce(tr('Agente {0} salvo.', [saved.name]));
    } catch (err) {
      this.say(tr('Não salvou: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.saveBtn.disabled = false;
    }
  }

  private async remove(): Promise<void> {
    const a = this.editing;
    if (!a || this.busy) return;
    if (!confirm(tr('Apagar o agente {0}? As sessões que já começaram continuam.', [a.name]))) return;
    this.busy = true;
    try {
      await api(`/api/custom-agents/${encodeURIComponent(a.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      this.agents = this.agents.filter((x) => x.id !== a.id);
      this.showList();
      this.say(tr('{0} apagado.', [a.name]));
    } catch (err) {
      this.say(tr('Não apagou: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
    }
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}
