import { describe, expect, it } from 'vitest';
import { columnIndex, detectDelimiter, parseCsv } from './sheet';

describe('planilhas', () => {
  it('CSV com aspas, aspas escapadas e quebra de linha dentro do campo', () => {
    const s = parseCsv('nome,valor\n"Prefeitura, SP","R$ 1.000"\n"diz ""oi""","linha\nnova"\n');
    expect(s.rows).toEqual([
      ['nome', 'valor'],
      ['Prefeitura, SP', 'R$ 1.000'],
      ['diz "oi"', 'linha\nnova'],
    ]);
  });

  it('detecta ponto e vírgula e tabulação', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(parseCsv('a;b\r\n1;2').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('colunas do Excel', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA10')).toBe(26);
  });
});
