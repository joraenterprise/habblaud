import { describe, expect, it } from 'vitest';
import { parseTable, splitTableRow } from './markdown';

describe('tabelas do markdown', () => {
  it('cabeçalho, alinhamento e linhas', () => {
    expect(parseTable('| Arquivo | Linhas | Nota |\n|:---|---:|:-:|\n| a.ts | 10 | ok |\n| b.ts | 2 |')).toEqual({
      head: ['Arquivo', 'Linhas', 'Nota'],
      align: ['left', 'right', 'center'],
      rows: [
        ['a.ts', '10', 'ok'],
        ['b.ts', '2', ''],
      ],
    });
  });

  it('a tabela do relatório (links, aspas e parênteses dentro das células)', () => {
    const t = parseTable(
      '| Oportunidade | Motivo |\n|---|---|\n| BNDES, CPSI "Inteligência de Dados em Saúde" | Propostas até 08/09/2026 ([notícia](https://exemplo.com/a-b)) |',
    );
    expect(t?.head).toEqual(['Oportunidade', 'Motivo']);
    expect(t?.rows[0]).toEqual(['BNDES, CPSI "Inteligência de Dados em Saúde"', 'Propostas até 08/09/2026 ([notícia](https://exemplo.com/a-b))']);
  });

  it('barra escapada e barra dentro de código não separam células', () => {
    expect(splitTableRow('| a \\| b | `x | y` | c |')).toEqual(['a | b', '`x | y`', 'c']);
    expect(splitTableRow('sem bordas | dois')).toEqual(['sem bordas', 'dois']);
  });

  it('sem separador não é tabela montada', () => {
    expect(parseTable('| a | b |\n| c | d |')).toBeNull();
  });
});
