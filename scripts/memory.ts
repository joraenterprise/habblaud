// Memória do Habblaud (ai-memory, github.com/akitaonrails/ai-memory, MIT): o que o docker:up e o memory:install
// dividem. O servidor roda como serviço do docker-compose (perfil "memoria"); o cliente nativo (hooks e MCP das
// contas) é baixado da release, com a versão fixa e o checksum conferido. Os dois usam o mesmo token, guardado em
// ~/.habblaud/ai-memory-token na máquina dos agentes (com o Docker no WSL e os agentes no Windows, a pasta .habblaud do
// Windows é achada pelo HABBLAUD_USAGE_DIR, que o docker:up já usa para o uso de 5h/semanal).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Versão fixa do ai-memory (imagem do servidor e cliente nativo andam juntos). */
export const AI_MEMORY_VERSION = '3.1.0';
export const AI_MEMORY_IMAGE = `akitaonrails/ai-memory:${AI_MEMORY_VERSION}`;
export const AI_MEMORY_PORT = 49374;
/** Endereço dos hooks e do MCP das contas (o servidor publica só no loopback do host). */
export const AI_MEMORY_HOST_URL = `http://127.0.0.1:${AI_MEMORY_PORT}`;
/** Endereço visto de dentro do container do Habblaud (rede do Compose). */
export const AI_MEMORY_INTERNAL_URL = `http://ai-memory:${AI_MEMORY_PORT}`;
export const AI_MEMORY_PROFILE = 'memoria';
export const TOKEN_FILE_NAME = 'ai-memory-token';
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** HABBLAUD_AI_MEMORY=0 desliga a memória (o docker:up não sobe o serviço; o Habblaud não publica). */
export function memoryDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(0|false|no|nao|não|off)$/i.test(env.HABBLAUD_AI_MEMORY?.trim() ?? '');
}

/** Valor de uma variável num .env (linhas NOME=valor, com ou sem `export` e aspas). */
export function envFileValue(text: string, name: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m || m[1] !== name) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    return v || undefined;
  }
  return undefined;
}

/**
 * Onde procurar (e, na falta, gravar) o token, na ordem: HABBLAUD_AI_MEMORY_TOKEN_FILE, a pasta .habblaud da máquina
 * dos agentes (a mãe do HABBLAUD_USAGE_DIR, quando ele aponta para outra máquina, como o Windows visto do WSL) e a
 * ~/.habblaud local.
 */
export function tokenCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = [];
  const own = env.HABBLAUD_AI_MEMORY_TOKEN_FILE?.trim();
  if (own) out.push(own);
  const usage = env.HABBLAUD_USAGE_DIR?.trim();
  if (usage) out.push(join(dirname(usage.replace(/[\\/]+$/, '')), TOKEN_FILE_NAME));
  out.push(join(home, '.habblaud', TOKEN_FILE_NAME));
  return [...new Set(out)];
}

export interface TokenFs {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string): void;
}

const realFs: TokenFs = {
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, data) => {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, data, { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      // Windows: o arquivo fica na pasta do usuário
    }
  },
};

export type TokenSource = 'env' | 'env-file' | 'file' | 'new';

/**
 * O token do ai-memory: do ambiente, do .env (`envText`), de um arquivo de token ou, se nada disso existe e `create`,
 * um novo (64 hex) gravado no primeiro candidato. Undefined = não há token e não foi pedido criar.
 */
export function resolveToken(
  o: { env: NodeJS.ProcessEnv; home: string; envText?: string; create: boolean },
  fs: TokenFs = realFs,
): { token: string; source: TokenSource; path?: string } | undefined {
  const fromEnv = o.env.HABBLAUD_AI_MEMORY_TOKEN?.trim();
  if (fromEnv && TOKEN_RE.test(fromEnv)) return { token: fromEnv, source: 'env' };
  const fromFile = o.envText ? envFileValue(o.envText, 'HABBLAUD_AI_MEMORY_TOKEN') : undefined;
  if (fromFile && TOKEN_RE.test(fromFile)) return { token: fromFile, source: 'env-file' };
  const candidates = tokenCandidates(o.env, o.home);
  for (const path of candidates) {
    if (!fs.exists(path)) continue;
    const t = fs.read(path).trim();
    if (TOKEN_RE.test(t)) return { token: t, source: 'file', path };
  }
  if (!o.create) return undefined;
  const token = randomBytes(32).toString('hex');
  for (const path of candidates) {
    try {
      fs.write(path, token);
      return { token, source: 'new', path };
    } catch {
      // pasta sem escrita: tenta a próxima
    }
  }
  return { token, source: 'new' };
}

/** Variáveis que o docker compose precisa para subir (ou não) o serviço da memória. */
export function composeMemoryEnv(env: NodeJS.ProcessEnv, token: string | undefined): Record<string, string> {
  if (memoryDisabled(env) || !token) return {};
  const profiles = (env.COMPOSE_PROFILES ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return {
    COMPOSE_PROFILES: [...new Set([...profiles, AI_MEMORY_PROFILE])].join(','),
    HABBLAUD_AI_MEMORY_TOKEN: token,
    HABBLAUD_AI_MEMORY_URL: env.HABBLAUD_AI_MEMORY_URL?.trim() || AI_MEMORY_INTERNAL_URL,
  };
}
