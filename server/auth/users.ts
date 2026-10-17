// Login por pessoa (HABBLAUD_LOGIN=1): usuários com senha (scrypt, remote/password.ts) e papel, guardados em
// <dataDir>/users.json, e sessões em cookie assinado (HMAC) com o id do usuário. A assinatura usa uma chave por usuário
// derivada do hash da senha: trocar a senha encerra as sessões dele. "Sair" revoga o token (a lista sobrevive a
// reinícios). O primeiro acesso, sem nenhum usuário, cria o administrador.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { hashPassword, parsePasswordHash, verifyPassword } from '../remote/password';

export type Role = 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  passwordHash: string;
  disabled?: boolean;
  createdAt: number;
}

/** O que sai para a página (nunca o hash). */
export type PublicUser = Omit<User, 'passwordHash'>;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;
export const PASSWORD_MIN = 8;
export const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
export const COOKIE = 'habblaud_session';

export const publicUser = ({ passwordHash: _h, ...u }: User): PublicUser => u;

export function checkUsername(raw: unknown): string | { error: string } {
  const u = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return USERNAME_RE.test(u) ? u : { error: tr('usuário: 2 a 32 caracteres (letras minúsculas, números, ponto, hífen, sublinhado)') };
}

export function checkPassword(raw: unknown): string | { error: string } {
  const p = typeof raw === 'string' ? raw : '';
  return p.length >= PASSWORD_MIN && p.length <= 200 ? p : { error: tr('a senha precisa ter de {0} a 200 caracteres', [PASSWORD_MIN]) };
}

export class UserStore {
  private users = new Map<string, User>();

  /** `file` null = só em memória (testes). */
  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
    private readonly hash: (p: string) => Promise<string> = (p) => hashPassword(p),
  ) {
    this.load();
  }

  count(): number {
    return this.users.size;
  }

  list(): PublicUser[] {
    return [...this.users.values()].sort((a, b) => a.username.localeCompare(b.username)).map(publicUser);
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  byUsername(username: string): User | undefined {
    const u = username.trim().toLowerCase();
    return [...this.users.values()].find((x) => x.username === u);
  }

  admins(): number {
    return [...this.users.values()].filter((u) => u.role === 'admin' && !u.disabled).length;
  }

  async create(raw: { username?: unknown; name?: unknown; password?: unknown; role?: unknown }): Promise<PublicUser | { error: string }> {
    const username = checkUsername(raw.username);
    if (typeof username !== 'string') return username;
    if (this.byUsername(username)) return { error: tr('já existe o usuário {0}', [username]) };
    const password = checkPassword(raw.password);
    if (typeof password !== 'string') return password;
    const name = (typeof raw.name === 'string' ? raw.name.trim() : '').slice(0, 60) || username;
    // O primeiro usuário é sempre administrador.
    const role: Role = this.users.size === 0 || raw.role === 'admin' ? 'admin' : 'member';
    const user: User = { id: randomUUID(), username, name, role, passwordHash: await this.hash(password), createdAt: this.now() };
    this.users.set(user.id, user);
    this.save();
    return publicUser(user);
  }

  async update(id: string, raw: { name?: unknown; role?: unknown; password?: unknown; disabled?: unknown }): Promise<PublicUser | { error: string }> {
    const u = this.users.get(id);
    if (!u) return { error: tr('usuário não encontrado') };
    const next = { ...u };
    if (typeof raw.name === 'string' && raw.name.trim()) next.name = raw.name.trim().slice(0, 60);
    if (raw.role === 'admin' || raw.role === 'member') next.role = raw.role;
    if (typeof raw.disabled === 'boolean') next.disabled = raw.disabled || undefined;
    if (raw.password !== undefined) {
      const p = checkPassword(raw.password);
      if (typeof p !== 'string') return p;
      next.passwordHash = await this.hash(p);
    }
    // Nunca fica sem nenhum administrador ativo.
    const losingAdmin = u.role === 'admin' && !u.disabled && (next.role !== 'admin' || next.disabled);
    if (losingAdmin && this.admins() <= 1) return { error: tr('o Habblaud precisa de pelo menos um administrador ativo') };
    this.users.set(id, next);
    this.save();
    return publicUser(next);
  }

  remove(id: string): true | { error: string } {
    const u = this.users.get(id);
    if (!u) return { error: tr('usuário não encontrado') };
    if (u.role === 'admin' && !u.disabled && this.admins() <= 1) return { error: tr('o Habblaud precisa de pelo menos um administrador ativo') };
    this.users.delete(id);
    this.save();
    return true;
  }

  /** Confere usuário e senha (o scrypt roda sempre, mesmo com usuário inexistente). */
  async authenticate(username: unknown, password: unknown): Promise<User | undefined> {
    const u = typeof username === 'string' ? this.byUsername(username) : undefined;
    const stored = parsePasswordHash(u?.passwordHash) ?? DUMMY;
    const ok = await verifyPassword(typeof password === 'string' ? password : '', stored);
    return ok && u && !u.disabled ? u : undefined;
  }

  private load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { users?: User[] };
      for (const u of j.users ?? []) if (u?.id && USERNAME_RE.test(u.username) && parsePasswordHash(u.passwordHash)) this.users.set(u.id, { ...u, role: u.role === 'admin' ? 'admin' : 'member' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(tr('users.json ilegível ({0}).', [errMsg(err)]));
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, users: [...this.users.values()] }, null, 2), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warn(tr('Não consegui gravar {0}: {1}', [this.file, errMsg(err)]));
    }
  }
}

/** Hash fixo para o scrypt rodar quando o usuário não existe (mesmo tempo de resposta). */
const DUMMY = parsePasswordHash('scrypt:15:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')!;

/** Sessões assinadas: "v2.<id do usuário>.<validade>.<assinatura>". */
export class UserSessions {
  private readonly revoked = new Map<string, number>();

  constructor(
    private readonly secret: Buffer,
    private readonly users: UserStore,
    private readonly now: () => number = Date.now,
    private readonly revokedFile?: string,
  ) {
    this.loadRevoked();
  }

  private sign(user: User, payload: string): string {
    const key = createHmac('sha256', this.secret).update(`${user.id}\0${user.passwordHash}`, 'utf8').digest();
    return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
  }

  issue(user: User): { token: string; maxAgeS: number } {
    const payload = `v2.${user.id}.${this.now() + SESSION_MS}`;
    return { token: `${payload}.${this.sign(user, payload)}`, maxAgeS: Math.floor(SESSION_MS / 1000) };
  }

  /** O usuário do token, se ele é válido, não venceu, não foi revogado e o usuário segue ativo. */
  verify(token: string | undefined): User | undefined {
    const p = this.parse(token);
    return p && !this.revoked.has(p.sig) ? p.user : undefined;
  }

  revoke(token: string | undefined): void {
    const p = this.parse(token);
    if (!p) return;
    const now = this.now();
    for (const [sig, exp] of this.revoked) if (exp <= now) this.revoked.delete(sig);
    this.revoked.set(p.sig, p.exp);
    this.saveRevoked();
  }

  private parse(token: string | undefined): { user: User; exp: number; sig: string } | undefined {
    const m = /^v2\.([0-9a-f-]{36})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
    if (!m) return undefined;
    const exp = Number(m[2]);
    const user = this.users.get(m[1]);
    if (!user || user.disabled || exp <= this.now()) return undefined;
    const expected = Buffer.from(this.sign(user, `v2.${m[1]}.${m[2]}`));
    const got = Buffer.from(m[3]);
    return expected.length === got.length && timingSafeEqual(expected, got) ? { user, exp, sig: m[3] } : undefined;
  }

  private loadRevoked(): void {
    if (!this.revokedFile) return;
    try {
      const data = JSON.parse(readFileSync(this.revokedFile, 'utf8')) as Record<string, unknown>;
      const now = this.now();
      for (const [sig, exp] of Object.entries(data)) if (typeof exp === 'number' && exp > now) this.revoked.set(sig, exp);
    } catch {
      // ninguém saiu ainda
    }
  }

  private saveRevoked(): void {
    if (!this.revokedFile) return;
    try {
      mkdirSync(dirname(this.revokedFile), { recursive: true });
      writeFileSync(`${this.revokedFile}.tmp`, JSON.stringify(Object.fromEntries(this.revoked)), { mode: 0o600 });
      renameSync(`${this.revokedFile}.tmp`, this.revokedFile);
    } catch {
      // vale em memória até reiniciar
    }
  }
}
