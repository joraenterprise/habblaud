import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_MEMORY_INTERNAL_URL, composeMemoryEnv, envFileValue, memoryDisabled, resolveToken, tokenCandidates, type TokenFs } from '../../scripts/memory';
import { parseSha256, releaseAsset, unsafeEntries } from '../../scripts/memory-install';

const T = 'a'.repeat(64);

const memFs = (files: Record<string, string> = {}, readonly: string[] = []): TokenFs & { files: Record<string, string> } => ({
  files,
  exists: (p) => p in files,
  read: (p) => files[p],
  write: (p, d) => {
    if (readonly.includes(p)) throw new Error('EACCES');
    files[p] = d;
  },
});

describe('memória: token', () => {
  it('procura no arquivo pedido, na .habblaud dos agentes (pela pasta do uso) e na local', () => {
    expect(tokenCandidates({ HABBLAUD_USAGE_DIR: '/mnt/c/Users/f/.habblaud/usage' }, '/home/f')).toEqual([join('/mnt/c/Users/f/.habblaud', 'ai-memory-token'), join('/home/f', '.habblaud', 'ai-memory-token')]);
    expect(tokenCandidates({ HABBLAUD_AI_MEMORY_TOKEN_FILE: '/x/t' }, '/home/f')[0]).toBe('/x/t');
  });

  it('ambiente, depois .env, depois arquivo; sem nada, cria e grava no primeiro', () => {
    expect(resolveToken({ env: { HABBLAUD_AI_MEMORY_TOKEN: T }, home: '/h', create: false }, memFs())).toEqual({ token: T, source: 'env' });
    expect(resolveToken({ env: {}, home: '/h', envText: `X=1\nexport HABBLAUD_AI_MEMORY_TOKEN="${T}"\n`, create: false }, memFs())).toEqual({ token: T, source: 'env-file' });
    expect(resolveToken({ env: {}, home: '/h', create: false }, memFs({ [join('/h', '.habblaud', 'ai-memory-token')]: `${T}\n` }))).toMatchObject({ token: T, source: 'file' });
    expect(resolveToken({ env: {}, home: '/h', create: false }, memFs())).toBeUndefined();
    const fs = memFs({}, [join('/mnt/c/.habblaud', 'ai-memory-token')]);
    const made = resolveToken({ env: { HABBLAUD_USAGE_DIR: '/mnt/c/.habblaud/usage' }, home: '/h', create: true }, fs);
    expect(made).toMatchObject({ source: 'new', path: join('/h', '.habblaud', 'ai-memory-token') });
    expect(made!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.files[join('/h', '.habblaud', 'ai-memory-token')]).toBe(made!.token);
  });

  it('ignora token curto ou com caracteres estranhos', () => {
    expect(resolveToken({ env: { HABBLAUD_AI_MEMORY_TOKEN: 'curto' }, home: '/h', create: false }, memFs())).toBeUndefined();
    expect(envFileValue('A=1\nB = "x y"\n', 'B')).toBe('x y');
  });
});

describe('memória: compose', () => {
  it('liga o perfil e passa token e endereço interno; HABBLAUD_AI_MEMORY=0 desliga', () => {
    expect(composeMemoryEnv({ COMPOSE_PROFILES: 'outro' }, T)).toEqual({ COMPOSE_PROFILES: 'outro,memoria', HABBLAUD_AI_MEMORY_TOKEN: T, HABBLAUD_AI_MEMORY_URL: AI_MEMORY_INTERNAL_URL });
    expect(composeMemoryEnv({ HABBLAUD_AI_MEMORY: '0' }, T)).toEqual({});
    expect(memoryDisabled({ HABBLAUD_AI_MEMORY: 'off' })).toBe(true);
    expect(memoryDisabled({})).toBe(false);
  });
});

describe('memória: cliente', () => {
  it('pacote certo por sistema', () => {
    expect(releaseAsset('win32', 'x64')).toBe('ai-memory-windows-x86_64.zip');
    expect(releaseAsset('linux', 'arm64')).toBe('ai-memory-linux-aarch64.tar.gz');
    expect(releaseAsset('win32', 'arm64')).toBeUndefined();
  });

  it('recusa caminhos suspeitos no pacote e lê o .sha256', () => {
    expect(unsafeEntries(['ai-memory.exe', 'hooks/a.ps1', '../x', '/etc/passwd', 'C:\\x', 'a/../../b'])).toEqual(['../x', '/etc/passwd', 'C:\\x', 'a/../../b']);
    expect(parseSha256(`${'AB'.repeat(32)}  ai-memory.zip\n`)).toBe('ab'.repeat(32));
    expect(parseSha256('nada')).toBeUndefined();
  });
});
