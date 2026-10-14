import { describe, expect, it } from 'vitest';
import { agentFiles, hasAgentFile } from './agent-files';
import type { TerminalEntry } from './types';

const tool = (id: string, name: string, files: string[], at = 1): TerminalEntry => ({ kind: 'tool', id, at, tool: name, title: `${name}(x)`, files });
const say = (id: string, text: string, at = 5): TerminalEntry => ({ kind: 'assistant', id, at, text });

describe('arquivos do agente', () => {
  it('junta escritos, editados, enviados e citados, do mais recente ao mais antigo', () => {
    const files = agentFiles(
      [
        tool('1', 'Write', ['C:\\Users\\f\\proj\\oportunidades\\2026-10-14.md'], 1),
        tool('2', 'Edit', ['C:\\Users\\f\\proj\\src\\app.ts'], 2),
        tool('3', 'SendUserFile', ['/tmp/print.png'], 3),
        say('4', 'Salvei em [relatório](oportunidades/2026-10-14.md) e a planilha em C:\\Users\\f\\proj\\dados.xlsx.', 4),
      ],
      'C:\\Users\\f\\proj',
    );
    expect(files.map((f) => [f.name, f.how])).toEqual([
      ['2026-10-14.md', 'criado'],
      ['dados.xlsx', 'citado'],
      ['print.png', 'enviado'],
      ['app.ts', 'editado'],
    ]);
    expect(files[0].at).toBe(4);
    expect(files[1]).toMatchObject({ path: 'C:\\Users\\f\\proj\\dados.xlsx', ext: 'xlsx' });
  });

  it('ignora links da web, âncoras e extensões que não se mostram', () => {
    const files = agentFiles([say('1', 'Veja https://pncp.gov.br/x.pdf, [aqui](#topo) e /usr/bin/node')], '/p');
    expect(files).toEqual([]);
  });

  it('confere se um caminho é do agente (barras e maiúsculas do Windows)', () => {
    const files = agentFiles([tool('1', 'Write', ['C:\\Users\\F\\a.md'])]);
    expect(hasAgentFile(files, 'c:/users/f/a.md')).toBe(true);
    expect(hasAgentFile(files, 'C:\\Users\\F\\b.md')).toBe(false);
  });
});
