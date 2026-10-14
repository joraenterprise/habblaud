import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubRepo, parseProjectJob, ProjectService, repoFolderName, runProjectJob, type Cmd } from './projects';

describe('novo projeto: pedido', () => {
  it('confere nomes, pasta e repositório', () => {
    expect(parseProjectJob({ kind: 'info' })).toEqual({ kind: 'info' });
    expect(parseProjectJob({ kind: 'create', base: 'C:\\code', name: 'meu-app' })).toEqual({ kind: 'create', base: 'C:\\code', name: 'meu-app' });
    expect(parseProjectJob({ kind: 'create', base: '/c', name: 'x', github: { owner: 'joraenterprise', visibility: 'public' } })).toMatchObject({ github: { owner: 'joraenterprise', visibility: 'public' } });
    expect(parseProjectJob({ kind: 'create', base: '/c', name: 'x', github: { owner: 'a b' } })).toHaveProperty('error');
    expect(parseProjectJob({ kind: 'create', base: 'relativa', name: 'x' })).toHaveProperty('error');
    for (const bad of ['..', '-x', 'a/b', 'a b', '']) expect(parseProjectJob({ kind: 'create', base: '/c', name: bad })).toHaveProperty('error');
    expect(parseProjectJob({ kind: 'clone', base: '/c', repo: 'dono/repo' })).toEqual({ kind: 'clone', base: '/c', repo: 'dono/repo', name: 'repo' });
    expect(parseProjectJob({ kind: 'clone', base: '/c', repo: '--upload-pack=x' })).toHaveProperty('error');
    expect(parseProjectJob({ kind: 'nada' })).toHaveProperty('error');
  });

  it('entende os formatos de repositório do GitHub', () => {
    expect(githubRepo('dono/repo')).toEqual({ owner: 'dono', name: 'repo' });
    expect(githubRepo('https://github.com/dono/repo.git')).toEqual({ owner: 'dono', name: 'repo' });
    expect(githubRepo('git@github.com:dono/repo.git')).toEqual({ owner: 'dono', name: 'repo' });
    expect(githubRepo('https://gitlab.com/dono/repo.git')).toBeUndefined();
    expect(repoFolderName('https://gitlab.com/dono/outro.git')).toBe('outro');
  });
});

describe('novo projeto: execução', () => {
  const fake = (fail?: string) => {
    const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
    const cmd: Cmd = async (bin, args, opts) => {
      calls.push({ bin, args, cwd: opts.cwd });
      if (fail && args.includes(fail)) return { ok: false, error: `${bin}: recusado` };
      if (args[0] === 'api' && args[1] === 'user') return { ok: true, stdout: 'lipeh777\n' };
      if (args[0] === 'api') return { ok: true, stdout: 'joraenterprise\nbyndcloud\n' };
      return { ok: true, stdout: '' };
    };
    return { calls, cmd };
  };
  const fs = { isDir: () => true, exists: () => false, mkdir: () => {}, writeFile: () => {} };

  it('info: git, conta e organizações do gh', async () => {
    const { cmd } = fake();
    expect(await runProjectJob({ kind: 'info' }, { cmd, home: '/h' })).toEqual({ ok: true, kind: 'info', info: { home: '/h', git: true, gh: true, ghUser: 'lipeh777', owners: ['lipeh777', 'joraenterprise', 'byndcloud'] } });
  });

  it('cria a pasta com git e o repositório no GitHub', async () => {
    const { calls, cmd } = fake();
    const r = await runProjectJob({ kind: 'create', base: '/c', name: 'app', github: { owner: 'joraenterprise', visibility: 'private' } }, { cmd, ...fs });
    const path = join('/c', 'app');
    expect(r).toEqual({ ok: true, kind: 'create', path, url: 'https://github.com/joraenterprise/app' });
    expect(calls.map((c) => [c.bin, ...c.args].join(' '))).toEqual([
      'git init -b main',
      'git add -A',
      'git commit -m Primeiro commit',
      'gh repo create joraenterprise/app --private --source . --remote origin --push',
    ]);
    expect(calls.every((c) => c.cwd === path)).toBe(true);
  });

  it('GitHub recusou: o projeto local fica, com aviso', async () => {
    const { cmd } = fake('create');
    expect(await runProjectJob({ kind: 'create', base: '/c', name: 'app', github: { owner: 'x', visibility: 'private' } }, { cmd, ...fs })).toMatchObject({ ok: true, path: join('/c', 'app'), note: expect.stringContaining('recusado') });
  });

  it('não sobrescreve pasta existente e confere a pasta base', async () => {
    const { cmd } = fake();
    expect(await runProjectJob({ kind: 'create', base: '/c', name: 'app' }, { cmd, ...fs, exists: () => true })).toMatchObject({ ok: false });
    expect(await runProjectJob({ kind: 'create', base: '/c', name: 'app' }, { cmd, ...fs, isDir: () => false })).toMatchObject({ ok: false });
  });

  it('clona pelo gh (GitHub) ou pelo git (outros)', async () => {
    const a = fake();
    await runProjectJob({ kind: 'clone', base: '/c', repo: 'dono/repo', name: 'repo' }, { cmd: a.cmd, ...fs });
    expect(a.calls[0]).toMatchObject({ bin: 'gh', args: ['repo', 'clone', 'dono/repo', join('/c', 'repo')] });
    const b = fake();
    await runProjectJob({ kind: 'clone', base: '/c', repo: 'https://gitlab.com/d/r.git', name: 'r' }, { cmd: b.cmd, ...fs });
    expect(b.calls[0]).toMatchObject({ bin: 'git', args: ['clone', '--', 'https://gitlab.com/d/r.git', join('/c', 'r')] });
  });
});

describe('novo projeto: fila do auxiliar', () => {
  it('sem auxiliar recusa; com ele entrega, recebe o resultado e confere o caminho', () => {
    let now = 0;
    const s = new ProjectService({ now: () => now, newId: () => 'p1' });
    expect(s.submit({ kind: 'info' })).toMatchObject({ error: 'unavailable' });
    s.poll();
    expect(s.submit({ kind: 'create', base: '/c', name: 'app' })).toMatchObject({ job: { id: 'p1', status: 'queued' } });
    expect(s.poll()).toEqual([{ id: 'p1', kind: 'create', base: '/c', name: 'app' }]);
    s.ack({ results: [{ id: 'p1', ok: true, path: '/c/app', url: 'https://github.com/a/app' }] });
    expect(s.get('p1')).toMatchObject({ status: 'done', path: '/c/app', url: 'https://github.com/a/app' });
    now = 1;
  });

  it('resultado com caminho inválido vira falha', () => {
    const s = new ProjectService({ newId: () => 'p2' });
    s.poll();
    s.submit({ kind: 'create', base: '/c', name: 'app' });
    s.poll();
    s.ack({ results: [{ id: 'p2', ok: true, path: 'relativo' }] });
    expect(s.get('p2')).toMatchObject({ status: 'failed' });
  });

  it('modo direto roda na hora', async () => {
    const s = new ProjectService({ run: async () => ({ ok: true, kind: 'create', path: '/c/x' }), newId: () => 'p3' });
    s.submit({ kind: 'create', base: '/c', name: 'x' });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(s.get('p3')).toMatchObject({ status: 'done', path: '/c/x' });
  });
});
