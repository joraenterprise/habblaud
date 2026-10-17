// Liga as contas à memória do Habblaud (ai-memory): baixa o cliente nativo da versão fixa (scripts/memory.ts), confere
// o checksum, e instala em cada conta do Claude Code (e, com --codex, do Codex) os hooks que gravam o que a sessão faz
// e o MCP com as ferramentas de memória, apontando para o servidor que o docker:up sobe (127.0.0.1:49374, com token).
// Rode na máquina onde os agentes rodam (no Windows com o Habblaud no WSL: no Windows).
//
//   npm run memory:install   [-- --codex] [-- --conta <pasta>]
//   npm run memory:status
//   npm run memory:uninstall
//
// O instalador do próprio ai-memory faz backup de cada arquivo que mexe (settings.json, .claude.json...). O token fica
// nos hooks e no MCP de cada conta, como o ai-memory pede: trate essas pastas como sensíveis (já são: têm o login).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverClaudeDirs } from '../server/accounts/detect';
import { AI_MEMORY_HOST_URL, AI_MEMORY_VERSION, resolveToken } from './memory';

const HOME = process.env.HOME || process.env.USERPROFILE || homedir();
const BASE = join(HOME, '.habblaud', 'ai-memory');
const CLIENT_DATA = join(BASE, 'client');
const RELEASE = `https://github.com/akitaonrails/ai-memory/releases/download/v${AI_MEMORY_VERSION}`;

const say = (s: string) => console.log(`[memory] ${s}`);
const fail = (s: string): never => {
  console.error(`[memory] Erro: ${s}`);
  process.exit(1);
};

/** O pacote da release para este sistema, ou undefined se não há cliente nativo para ele. */
export function releaseAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform === 'win32' && arch === 'x64') return 'ai-memory-windows-x86_64.zip';
  if (platform === 'linux' && arch === 'x64') return 'ai-memory-linux-x86_64.tar.gz';
  if (platform === 'linux' && arch === 'arm64') return 'ai-memory-linux-aarch64.tar.gz';
  if (platform === 'darwin' && arch === 'arm64') return 'ai-memory-macos-aarch64.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'ai-memory-macos-x86_64.tar.gz';
  return undefined;
}

/** Entradas de um pacote que não podem ser extraídas: caminho absoluto, unidade do Windows ou "..". */
export function unsafeEntries(entries: readonly string[]): string[] {
  return entries.filter((e) => e.startsWith('/') || e.startsWith('\\') || /^[A-Za-z]:/.test(e) || e.split(/[\\/]/).includes('..'));
}

/** Primeira palavra do arquivo .sha256 (o hash), em minúsculas. */
export function parseSha256(text: string): string | undefined {
  const h = text.trim().split(/\s+/)[0]?.toLowerCase();
  return h && /^[0-9a-f]{64}$/.test(h) ? h : undefined;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) fail(`não consegui baixar ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

const exeName = process.platform === 'win32' ? 'ai-memory.exe' : 'ai-memory';

/** O cliente da versão fixa, baixado e conferido se ainda não estiver em ~/.habblaud/ai-memory/<versão>. */
async function ensureClient(): Promise<string> {
  const dir = join(BASE, AI_MEMORY_VERSION);
  const exe = join(dir, exeName);
  if (existsSync(exe)) return exe;
  const asset = releaseAsset() ?? fail(`não há cliente do ai-memory para ${process.platform}/${process.arch}`);
  say(`baixando o cliente ai-memory ${AI_MEMORY_VERSION} (${asset})…`);
  const [data, sumText] = await Promise.all([download(`${RELEASE}/${asset}`), download(`${RELEASE}/${asset}.sha256`)]);
  const expected = parseSha256(sumText.toString('utf8')) ?? fail('arquivo .sha256 ilegível');
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) fail(`checksum diferente em ${asset}: o download foi recusado`);
  say('checksum ok');
  const tmp = join(tmpdir(), `habblaud-ai-memory-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(tmp, asset);
  writeFileSync(archive, data);
  // tar lê .zip e .tar.gz (no Windows 10+ é o bsdtar do sistema).
  const list = spawnSync('tar', ['-tf', archive], { encoding: 'utf8' });
  if (list.status !== 0) fail(`não consegui ler o pacote (${list.stderr?.trim() || 'tar falhou'})`);
  const bad = unsafeEntries(list.stdout.split(/\r?\n/).filter(Boolean));
  if (bad.length) fail(`o pacote tem caminhos suspeitos (${bad.slice(0, 3).join(', ')}): recusado`);
  const out = join(tmp, 'x');
  mkdirSync(out);
  const x = spawnSync('tar', ['-xf', archive, '-C', out], { encoding: 'utf8' });
  if (x.status !== 0) fail(`não consegui extrair o pacote (${x.stderr?.trim() || 'tar falhou'})`);
  // O executável pode estar na raiz ou numa pasta do pacote: a pasta dele vira a da versão.
  const found = findFile(out, exeName) ?? fail('o pacote não tem o executável do ai-memory');
  mkdirSync(BASE, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  renameSync(join(found, '..'), dir);
  rmSync(tmp, { recursive: true, force: true });
  if (process.platform !== 'win32') spawnSync('chmod', ['755', exe]);
  return exe;
}

function findFile(dir: string, name: string, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  for (const entry of readdir(dir)) {
    const sub = findFile(join(dir, entry), name, depth + 1);
    if (sub) return sub;
  }
  return undefined;
}

function readdir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Roda o cliente com a pasta de dados própria e o ambiente da conta. Devolve a saída sem o token. */
function run(exe: string, args: string[], env: Record<string, string>, token: string): { ok: boolean; out: string } {
  const r = spawnSync(exe, ['--data-dir', CLIENT_DATA, ...args], { encoding: 'utf8', env: { ...process.env, ...env, AI_MEMORY_SERVER_URL: AI_MEMORY_HOST_URL, AI_MEMORY_AUTH_TOKEN: token } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/\bINFO\b/.test(l))
    .join('\n')
    .split(token)
    .join('<token>');
  return { ok: r.status === 0, out };
}

interface Target {
  label: string;
  env: Record<string, string>;
  hooks: string[];
  mcp: string[];
}

function targets(argv: string[]): Target[] {
  const only = argv.flatMap((a, i) => (a === '--conta' && argv[i + 1] ? [argv[i + 1]] : []));
  const claude = (only.length ? only : discoverClaudeDirs(process.env, HOME)).map<Target>((dir) => ({
    label: `Claude Code ${dir.replace(HOME, '~')}`,
    env: { CLAUDE_CONFIG_DIR: dir },
    hooks: ['install-hooks', '--agent', 'claude-code', '--server-url', AI_MEMORY_HOST_URL],
    mcp: ['install-mcp', '--client', 'claude-code', '--server-url', `${AI_MEMORY_HOST_URL}/mcp`],
  }));
  if (!argv.includes('--codex')) return claude;
  const codexHome = process.env.CODEX_HOME?.trim() || join(HOME, '.codex');
  if (!existsSync(codexHome)) return claude;
  return [
    ...claude,
    {
      label: `Codex ${codexHome.replace(HOME, '~')}`,
      env: { CODEX_HOME: codexHome },
      hooks: ['install-hooks', '--agent', 'codex', '--server-url', AI_MEMORY_HOST_URL],
      mcp: ['install-mcp', '--client', 'codex', '--server-url', `${AI_MEMORY_HOST_URL}/mcp`],
    },
  ];
}

function tokenOrFail(): string {
  let envText: string | undefined;
  try {
    envText = readFileSync(join(process.cwd(), '.env'), 'utf8');
  } catch {
    // sem .env
  }
  const t = resolveToken({ env: process.env, home: HOME, envText, create: true });
  if (!t) fail('sem token da memória');
  if (t!.source === 'new') say(`token novo em ${t!.path ?? '?'}: rode o npm run docker:up de novo para o servidor usar o mesmo`);
  return t!.token;
}

async function serverUp(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${AI_MEMORY_HOST_URL}/admin/projects`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function install(argv: string[]): Promise<void> {
  const token = tokenOrFail();
  if (!(await serverUp(token))) say(`aviso: o servidor da memória não respondeu em ${AI_MEMORY_HOST_URL} (npm run docker:up); os hooks guardam os eventos e mandam depois`);
  const exe = await ensureClient();
  const list = targets(argv);
  if (!list.length) fail('nenhuma conta do Claude Code encontrada (~/.claude*)');
  for (const t of list) {
    for (const args of [t.hooks, t.mcp]) {
      const r = run(exe, [...args, '--auth-token', token, '--apply'], t.env, token);
      say(`${r.ok ? '✓' : '✗'} ${t.label}: ${args[0]}${r.ok ? '' : `\n${r.out}`}`);
    }
  }
  say(`pronto. Sessões novas já gravam na memória; nas abertas, reabra a sessão. Conferir: npm run memory:status`);
}

async function status(): Promise<void> {
  const t = resolveToken({ env: process.env, home: HOME, create: false });
  if (!t) fail('sem token da memória: rode npm run docker:up');
  say(`servidor ${AI_MEMORY_HOST_URL}: ${(await serverUp(t!.token)) ? 'no ar' : 'fora do ar'}`);
  const exe = join(BASE, AI_MEMORY_VERSION, exeName);
  say(`cliente ${AI_MEMORY_VERSION}: ${existsSync(exe) ? exe : 'não instalado (npm run memory:install)'}`);
  for (const t2 of targets(process.argv.slice(3))) {
    const dir = t2.env.CLAUDE_CONFIG_DIR ?? t2.env.CODEX_HOME;
    const settings = dir && t2.env.CLAUDE_CONFIG_DIR ? join(dir, 'settings.json') : dir ? join(dir, 'hooks.json') : '';
    let wired = false;
    try {
      wired = readFileSync(settings, 'utf8').includes('ai-memory');
    } catch {
      // sem arquivo
    }
    say(`${t2.label}: hooks ${wired ? 'ligados' : 'não ligados'}`);
  }
}

function uninstall(argv: string[]): void {
  const exe = join(BASE, AI_MEMORY_VERSION, exeName);
  if (!existsSync(exe)) fail('cliente não instalado: nada a desfazer');
  const t = resolveToken({ env: process.env, home: HOME, create: false });
  for (const target of targets(argv)) {
    const r = run(exe, ['uninstall', '--apply'], target.env, t?.token ?? '');
    say(`${r.ok ? '✓' : '✗'} ${target.label}: uninstall${r.ok ? '' : `\n${r.out}`}`);
  }
  say('a memória em si (o volume ai-memory-data) fica; o servidor sai com HABBLAUD_AI_MEMORY=0 no .env e npm run docker:up');
}

if (process.argv[1]?.endsWith('memory-install.ts')) {
  const [cmd, ...rest] = process.argv.slice(2);
  (cmd === 'install' ? install(rest) : cmd === 'status' ? status() : cmd === 'uninstall' ? Promise.resolve(uninstall(rest)) : Promise.resolve(fail('uso: npm run memory:<install|status|uninstall>'))).catch((err: unknown) =>
    fail(String((err as Error)?.message ?? err)),
  );
}
