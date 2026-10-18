// O banco de contas no computador dos agentes (shared/swap.ts): roda o claude-swap (cswap) e conduz o login do Claude
// para conectar contas novas. Quem usa: o auxiliar do host (scripts/codex-bridge.ts, com o Habblaud no Docker) ou o
// próprio servidor (modo Node), pelos pedidos `swap-*` de projects/projects.ts.
//
// Conectar conta sem mexer na conta ativa: `claude auth login` roda com CLAUDE_CONFIG_DIR numa pasta temporária (o
// login padrão e os agentes rodando ficam como estão); a página mostra o link, a pessoa entra no navegador dela e cola o
// código; o código vai pelo stdin; com o login feito, `cswap add` (com o mesmo CLAUDE_CONFIG_DIR) guarda a conta, e a
// pasta temporária (que tem a credencial) é apagada. Sem shell; o processo do login é encerrado pelo PID.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAdded, parseLoginUrl } from '../../shared/swap';
import { tr } from '../../shared/i18n';

const RUN_TIMEOUT_MS = 60_000;
const URL_TIMEOUT_MS = 30_000;
const CODE_TIMEOUT_MS = 90_000;
const LOGIN_TTL_MS = 15 * 60_000;
const OUT_MAX = 64 * 1024;

export type SwapResult = { ok: true; data: unknown } | { ok: false; error: string };

/** O cswap: HABBLAUD_CSWAP_BIN, o do pipx/uv (~/.local/bin) ou o do PATH. */
export function cswapBin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string {
  const own = env.HABBLAUD_CSWAP_BIN?.trim();
  if (own) return own;
  const home = env.USERPROFILE || env.HOME || homedir();
  const local = join(home, '.local', 'bin', platform === 'win32' ? 'cswap.exe' : 'cswap');
  return exists(local) ? local : 'cswap';
}

interface LoginSession {
  id: string;
  child: ChildProcess;
  dir: string;
  out: string;
  startedAt: number;
  done: boolean;
}

export interface SwapHostOptions {
  cswap?: string;
  /** O claude que faz o login (runnableClaudeBin). */
  claude?: string;
  now?: () => number;
}

export class SwapHost {
  private readonly logins = new Map<string, LoginSession>();
  private readonly cswap: string;
  private readonly now: () => number;

  constructor(private readonly o: SwapHostOptions = {}) {
    this.cswap = o.cswap ?? cswapBin();
    this.now = o.now ?? Date.now;
  }

  /** `cswap <args>`; com `input`, o texto vai pelo stdin (a chave de API nunca na linha de comando). */
  run(args: string[], opts: { env?: Record<string, string>; input?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; out: string; err: string }> {
    return new Promise((done) => {
      const child = execFile(this.cswap, args, { timeout: opts.timeoutMs ?? RUN_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...opts.env } }, (error, out, err) =>
        done({ ok: !error, out: out ?? '', err: (err || error?.message || '').slice(0, 2_000) }),
      );
      if (opts.input !== undefined) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
  }

  async list(): Promise<SwapResult> {
    const r = await this.run(['list', '--json']);
    try {
      return { ok: true, data: JSON.parse(r.out) as unknown };
    } catch {
      return { ok: false, error: r.err.split('\n').find((l) => l.trim()) ?? tr('o claude-swap não respondeu (instale com pipx install claude-swap)') };
    }
  }

  async switchTo(target: number): Promise<SwapResult> {
    const r = await this.run(['switch', String(target), '--json']);
    try {
      return { ok: true, data: JSON.parse(r.out) as unknown };
    } catch {
      return r.ok ? { ok: true, data: {} } : { ok: false, error: r.err.split('\n').find((l) => l.trim()) ?? tr('a troca falhou') };
    }
  }

  async setAlias(target: number, name: string): Promise<SwapResult> {
    const r = await this.run(['alias', String(target), name]);
    return r.ok ? { ok: true, data: {} } : { ok: false, error: (r.err || r.out).split('\n').find((l) => l.trim())?.slice(0, 300) ?? tr('o claude-swap recusou o apelido') };
  }

  async addToken(token: string, label?: string): Promise<SwapResult> {
    const args = ['add-token', '-'];
    if (label) args.push('--email', label);
    const r = await this.run(args, { input: `${token}\n` });
    const added = parseAdded(`${r.out}\n${r.err}`);
    return r.ok ? { ok: true, data: { added } } : { ok: false, error: (r.err || r.out).split('\n').find((l) => l.trim())?.slice(0, 300) ?? tr('o claude-swap recusou a chave') };
  }

  /** Começa um login numa pasta temporária e devolve o link para a pessoa abrir. */
  async loginStart(): Promise<SwapResult> {
    this.prune();
    const claude = this.o.claude ?? 'claude';
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-conta-'));
    const child = spawn(claude, ['auth', 'login'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir, BROWSER: 'none' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const s: LoginSession = { id: randomUUID(), child, dir, out: '', startedAt: this.now(), done: false };
    const take = (b: Buffer) => {
      s.out = (s.out + b.toString('utf8')).slice(-OUT_MAX);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('exit', () => (s.done = true));
    child.on('error', () => (s.done = true));
    this.logins.set(s.id, s);
    const url = await this.waitFor(s, () => parseLoginUrl(s.out), URL_TIMEOUT_MS);
    if (!url) {
      this.end(s);
      return { ok: false, error: tr('o claude não mostrou o link de login (ele está instalado neste computador?)') };
    }
    return { ok: true, data: { login: { id: s.id, url } } };
  }

  /** Manda o código colado, espera o login e guarda a conta no claude-swap. */
  async loginFinish(id: string, code: string): Promise<SwapResult> {
    const s = this.logins.get(id);
    if (!s) return { ok: false, error: tr('esse login venceu; comece de novo') };
    const clean = code.trim();
    if (!/^[A-Za-z0-9#_\-.~]{8,512}$/.test(clean)) return { ok: false, error: tr('o código colado não parece o do Claude') };
    try {
      s.child.stdin?.write(`${clean}\n`);
      const ok = await this.waitFor(s, () => (/login successful|logged in/i.test(s.out) ? true : s.done ? false : undefined), CODE_TIMEOUT_MS);
      if (!ok) return { ok: false, error: tr('o login não terminou ({0})', [lastLine(s.out)]) };
      const r = await this.run(['add'], { env: { CLAUDE_CONFIG_DIR: s.dir } });
      const added = parseAdded(`${r.out}\n${r.err}`);
      if (!r.ok || !added) return { ok: false, error: tr('o claude-swap não guardou a conta ({0})', [lastLine(`${r.err}\n${r.out}`)]) };
      return { ok: true, data: { added } };
    } finally {
      this.end(s);
    }
  }

  loginCancel(id: string): SwapResult {
    const s = this.logins.get(id);
    if (s) this.end(s);
    return { ok: true, data: {} };
  }

  private waitFor<T>(s: LoginSession, check: () => T | undefined, ms: number): Promise<T | undefined> {
    return new Promise((done) => {
      const end = this.now() + ms;
      const tick = () => {
        const v = check();
        if (v !== undefined) return done(v);
        if (this.now() > end || (s.done && check() === undefined)) return done(undefined);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  /** Encerra o processo do login (pelo PID) e apaga a pasta temporária, que guarda a credencial. */
  private end(s: LoginSession): void {
    this.logins.delete(s.id);
    try {
      if (!s.done && s.child.pid) process.kill(s.child.pid);
    } catch {
      // já saiu
    }
    try {
      rmSync(s.dir, { recursive: true, force: true });
    } catch {
      // o sistema limpa a pasta temporária depois
    }
  }

  private prune(): void {
    for (const s of this.logins.values()) if (this.now() - s.startedAt > LOGIN_TTL_MS) this.end(s);
  }
}

function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
      ?.slice(0, 200) ?? '-'
  );
}
