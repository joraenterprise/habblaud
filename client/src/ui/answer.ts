// Seção "Resposta" nos detalhes do agente: o último pedido, a resposta final (markdown) e o erro, se houver
// (GET /api/agents/:id/answer; shared/answer.ts). Relê quando o agente muda (nova atividade ou status), no máximo a
// cada REFRESH_MS enquanto ele trabalha. Só com o terminal disponível (a conversa tem a mesma trava).
import type { AgentAnswer } from '../../../shared/answer';
import { tr } from '../../../shared/i18n';
import type { AgentInfo } from '../../../shared/types';
import { h, setHidden, setText } from './dom';
import { renderMarkdown } from './markdown';

const REFRESH_MS = 3_000;

export class AnswerView {
  readonly el: HTMLElement;
  private readonly request: HTMLElement;
  private readonly error: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly errorHint: HTMLElement;
  private readonly body: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly expand: HTMLButtonElement;
  private readonly copy: HTMLButtonElement;
  private id = '';
  private key = '';
  private fetchedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private req = 0;
  private current: AgentAnswer | null = null;
  private expanded = false;

  constructor(title: HTMLElement) {
    this.request = h('p', { class: 'ui-answer__req' });
    this.errorText = h('p', { class: 'ui-answer__err-text' });
    this.errorHint = h('p', { class: 'ui-answer__err-hint' });
    this.error = h('div', { class: 'ui-answer__err', role: 'alert', hidden: true }, this.errorText, this.errorHint);
    this.body = h('div', { class: 'ui-answer__body ui-md' });
    this.empty = h('p', { class: 'ui-answer__empty', text: tr('Ainda sem resposta neste turno.') });
    this.expand = h('button', { class: 'ui-btn ui-answer__more', type: 'button', hidden: true, on: { click: () => this.toggleExpand() } }, tr('Ver tudo'));
    this.copy = h(
      'button',
      {
        class: 'ui-btn ui-answer__more',
        type: 'button',
        hidden: true,
        on: {
          click: async () => {
            const text = this.current?.answer ?? '';
            try {
              await navigator.clipboard.writeText(text);
              setText(this.copy, tr('Copiado!'));
            } catch {
              setText(this.copy, tr('Não foi possível copiar'));
            }
            setTimeout(() => setText(this.copy, tr('Copiar')), 1500);
          },
        },
      },
      tr('Copiar'),
    );
    this.el = h(
      'section',
      { class: 'ui-sec ui-answer', hidden: true },
      h('div', { class: 'ui-sec__head' }, title),
      this.request,
      this.error,
      this.body,
      this.empty,
      h('div', { class: 'ui-answer__actions' }, this.expand, this.copy),
    );
  }

  /** Agente aberto agora (ou null), e se a conversa pode ser lida daqui. */
  update(a: AgentInfo | null, enabled: boolean): void {
    if (!a || !enabled) {
      setHidden(this.el, true);
      return;
    }
    setHidden(this.el, false);
    if (a.id !== this.id) {
      this.id = a.id;
      this.key = '';
      this.current = null;
      this.expanded = false;
      this.render();
    }
    const key = `${a.id}|${a.status}|${a.lastEventAt ?? 0}`;
    if (key === this.key) return;
    this.key = key;
    const wait = Math.max(0, this.fetchedAt + REFRESH_MS - Date.now());
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.load();
    }, wait);
  }

  private async load(): Promise<void> {
    const id = this.id;
    const req = ++this.req;
    this.fetchedAt = Date.now();
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/answer`, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as AgentAnswer;
      if (req !== this.req || id !== this.id) return;
      this.current = body;
      this.render();
    } catch {
      // fica o que já estava
    }
  }

  private toggleExpand(): void {
    this.expanded = !this.expanded;
    this.render();
  }

  private render(): void {
    const a = this.current;
    setText(this.request, a?.request ? tr('Pedido: {0}', [a.request.length > 220 ? `${a.request.slice(0, 219)}…` : a.request]) : '');
    setHidden(this.request, !a?.request);
    setHidden(this.error, !a?.error);
    setText(this.errorText, a?.error ?? '');
    setText(
      this.errorHint,
      a?.loginExpired
        ? tr('O login do Claude Code no computador expirou, então o agente não trabalhou. Abra um terminal, rode claude, digite /login e depois peça de novo.')
        : '',
    );
    setHidden(this.errorHint, !a?.loginExpired);
    if (a?.answer) this.body.replaceChildren(renderMarkdown(a.answer));
    else this.body.replaceChildren();
    setHidden(this.body, !a?.answer);
    this.body.classList.toggle('is-clamped', !this.expanded);
    setHidden(this.empty, !!a?.answer || !!a?.error || !a);
    const long = (a?.answer?.length ?? 0) > 900;
    setHidden(this.expand, !long);
    setText(this.expand, this.expanded ? tr('Recolher') : tr('Ver tudo'));
    setHidden(this.copy, !a?.answer);
  }
}
