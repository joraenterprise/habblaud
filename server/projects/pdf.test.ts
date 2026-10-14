import { describe, expect, it } from 'vitest';
import { agentFiles, hasAgentFile } from '../../shared/agent-files';
import { parseProjectJob, pdfPathFor, runProjectJob, type Cmd } from './projects';

describe('gerar PDF de um HTML', () => {
  it('só aceita HTML com caminho absoluto', () => {
    expect(parseProjectJob({ kind: 'pdf', source: 'C:\\Users\\f\\p\\rel.html' })).toEqual({ kind: 'pdf', source: 'C:\\Users\\f\\p\\rel.html' });
    expect(parseProjectJob({ kind: 'pdf', source: '/p/rel.md' })).toHaveProperty('error');
    expect(parseProjectJob({ kind: 'pdf', source: 'rel.html' })).toHaveProperty('error');
    expect(pdfPathFor('C:\\p\\rel.HTML')).toBe('C:\\p\\rel.pdf');
  });

  it('roda o navegador sem janela, com perfil próprio, e confere o PDF', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    let made = false;
    const cmd: Cmd = async (bin, args) => {
      calls.push({ bin, args });
      made = true;
      return { ok: true, stdout: '' };
    };
    const exists = (p: string) => p === '/p/rel.html' || p === '/bin/edge' || (made && p === '/p/rel.pdf');
    const r = await runProjectJob({ kind: 'pdf', source: '/p/rel.html' }, { cmd, exists, browsers: ['/bin/chrome', '/bin/edge'], inside: () => true });
    expect(r).toEqual({ ok: true, kind: 'pdf', path: '/p/rel.pdf' });
    expect(calls[0].bin).toBe('/bin/edge');
    expect(calls[0].args).toEqual(expect.arrayContaining(['--headless', '--print-to-pdf=/p/rel.pdf']));
    // No Windows o caminho ganha a unidade (file:///C:/p/rel.html).
    expect(calls[0].args.at(-1)).toMatch(/^file:\/\/\/(?:[A-Z]:)?\/p\/rel\.html$/);
    expect(calls[0].args.some((a) => a.startsWith('--user-data-dir='))).toBe(true);
  });

  it('recusa HTML fora das pastas conhecidas, sem navegador ou que não gerou nada', async () => {
    const cmd: Cmd = async () => ({ ok: true, stdout: '' });
    const has = (p: string) => p === '/p/rel.html' || p === '/bin/edge';
    expect(await runProjectJob({ kind: 'pdf', source: '/p/rel.html' }, { cmd, exists: has, browsers: ['/bin/edge'], inside: () => false })).toMatchObject({ ok: false });
    expect(await runProjectJob({ kind: 'pdf', source: '/p/rel.html' }, { cmd, exists: (p) => p === '/p/rel.html', browsers: ['/bin/edge'] })).toMatchObject({ ok: false });
    expect(await runProjectJob({ kind: 'pdf', source: '/p/rel.html' }, { cmd, exists: has, browsers: ['/bin/edge'] })).toMatchObject({ ok: false, error: 'o navegador não gerou o PDF' });
  });

  it('o PDF ao lado de um HTML do agente pode ser aberto', () => {
    const files = agentFiles([{ kind: 'tool', id: '1', at: 1, tool: 'Write', title: 'Write(x)', files: ['C:\\Users\\f\\p\\rel.html'] }]);
    expect(hasAgentFile(files, 'C:\\Users\\f\\p\\rel.pdf')).toBe(true);
    expect(hasAgentFile(files, 'C:\\Users\\f\\p\\outro.pdf')).toBe(false);
  });
});
