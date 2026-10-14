import { describe, expect, it } from 'vitest';
import { lastAnswer } from './answer';
import type { TerminalEntry } from './types';

const u = (id: string, text: string): TerminalEntry => ({ kind: 'user', id, at: 1, text });
const t = (id: string, text: string): TerminalEntry => ({ kind: 'assistant', id, at: 2, text });
const tool = (id: string): TerminalEntry => ({ kind: 'tool', id, at: 3, tool: 'Bash', title: 'Bash(ls)' });
const err = (id: string, text: string): TerminalEntry => ({ kind: 'system', id, at: 4, text, level: 'error' });

describe('resposta do agente', () => {
  it('pega o último pedido e só o texto depois da última ferramenta', () => {
    const r = lastAnswer([u('1', 'antigo'), t('2', 'velho'), u('3', 'busque oportunidades'), t('4', 'Vou pesquisar.'), tool('5'), t('6', '## Achei 3'), t('7', 'Detalhes')]);
    expect(r).toEqual({ request: 'busque oportunidades', answer: '## Achei 3\n\nDetalhes', tools: 1, at: 2 });
  });

  it('erro de login vira dica', () => {
    const r = lastAnswer([u('1', 'busque'), err('2', 'Please run /login · API Error: 401 OAuth access token has expired.')]);
    expect(r).toMatchObject({ request: 'busque', error: expect.stringContaining('401'), loginExpired: true, tools: 0 });
    expect(r.answer).toBeUndefined();
  });

  it('erro superado por uma resposta depois some; comandos de barra não contam como pedido', () => {
    const r = lastAnswer([u('1', 'faça X'), err('2', 'Erro da API: overloaded'), t('3', 'Feito.'), u('4', '/model')]);
    expect(r).toMatchObject({ request: 'faça X', answer: 'Feito.' });
    expect(r.error).toBeUndefined();
  });

  it('conversa vazia', () => {
    expect(lastAnswer([])).toEqual({ tools: 0 });
  });
});
