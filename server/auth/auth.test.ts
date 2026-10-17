import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../remote/password';
import { createLoginGate, requestUser } from './gate';
import { COOKIE, UserSessions, UserStore } from './users';

const fastHash = (p: string) => hashPassword(p, 10);
const store = () => new UserStore(null, Date.now, fastHash);

describe('usuários', () => {
  it('o primeiro é administrador; nomes únicos e senha mínima', async () => {
    const s = store();
    expect(await s.create({ username: 'Filipe', password: 'segredo123' })).toMatchObject({ username: 'filipe', role: 'admin' });
    expect(await s.create({ username: 'maria', password: 'segredo123' })).toMatchObject({ role: 'member' });
    expect(await s.create({ username: 'maria', password: 'segredo123' })).toHaveProperty('error');
    expect(await s.create({ username: 'joao', password: 'curta' })).toHaveProperty('error');
    expect(await s.create({ username: 'x', password: 'segredo123' })).toHaveProperty('error');
    expect(s.list().every((u) => !('passwordHash' in u))).toBe(true);
  });

  it('confere a senha e nunca fica sem administrador', async () => {
    const s = store();
    const a = (await s.create({ username: 'admin', password: 'segredo123' })) as { id: string };
    expect(await s.authenticate('admin', 'segredo123')).toBeDefined();
    expect(await s.authenticate('admin', 'errada123')).toBeUndefined();
    expect(await s.authenticate('ninguem', 'segredo123')).toBeUndefined();
    expect(await s.update(a.id, { role: 'member' })).toHaveProperty('error');
    expect(s.remove(a.id)).toHaveProperty('error');
    await s.update(a.id, { disabled: false });
  });

  it('sessão: vale, sai com logout e cai quando a senha muda ou o usuário é desativado', async () => {
    const s = store();
    const a = (await s.create({ username: 'admin', password: 'segredo123' })) as { id: string };
    const m = (await s.create({ username: 'maria', password: 'segredo123' })) as { id: string };
    const sessions = new UserSessions(Buffer.alloc(32, 7), s);
    const t1 = sessions.issue(s.get(m.id)!).token;
    expect(sessions.verify(t1)?.username).toBe('maria');
    await s.update(m.id, { password: 'outrasenha1' });
    expect(sessions.verify(t1)).toBeUndefined();
    const t2 = sessions.issue(s.get(m.id)!).token;
    await s.update(m.id, { disabled: true });
    expect(sessions.verify(t2)).toBeUndefined();
    const t3 = sessions.issue(s.get(a.id)!).token;
    sessions.revoke(t3);
    expect(sessions.verify(t3)).toBeUndefined();
    expect(sessions.verify('v2.lixo')).toBeUndefined();
  });
});

describe('portão do login', () => {
  const fakeReq = (path: string, { method = 'GET', host = 'habblaud.example', cookie }: { method?: string; host?: string; cookie?: string } = {}) => {
    const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
    Object.assign(req, { method, url: path, headers: { host, ...(cookie ? { cookie } : {}) }, resume: () => req });
    return req;
  };
  const fakeRes = () => {
    const out: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
    const res = { headersSent: false, writeHead: (s: number, h: Record<string, unknown>) => ((out.status = s), (out.headers = h)), end: (b?: string) => (out.body = b) } as unknown as ServerResponse;
    return { res, out };
  };
  const setup = async () => {
    const users = store();
    const sessions = new UserSessions(Buffer.alloc(32, 1), users);
    const gate = createLoginGate({ users, sessions, isMachinePath: (p) => p.startsWith('/api/host/') || p === '/api/health', secure: false });
    return { users, sessions, gate };
  };
  const run = (gate: ReturnType<typeof createLoginGate>, req: IncomingMessage) => {
    const { res, out } = fakeRes();
    const handled = gate(req, res, new URL(req.url!, 'http://x'));
    return { handled, out };
  };

  it('sem login: página vai para /login, API dá 401, rota de máquina só pelo próprio computador', async () => {
    const { gate } = await setup();
    expect(run(gate, fakeReq('/')).out).toMatchObject({ status: 302, headers: { Location: '/login' } });
    expect(run(gate, fakeReq('/api/snapshot')).out.status).toBe(401);
    expect(run(gate, fakeReq('/api/host/spawn/poll', { method: 'POST', host: '127.0.0.1:4747' })).handled).toBe(false);
    expect(run(gate, fakeReq('/api/host/spawn/poll', { method: 'POST' })).out.status).toBe(401);
    expect(run(gate, fakeReq('/manifest.webmanifest')).handled).toBe(false);
  });

  it('a página de login vira primeiro acesso sem usuários', async () => {
    const { gate, users } = await setup();
    expect(run(gate, fakeReq('/login')).out.body).toContain('/api/auth/setup');
    await users.create({ username: 'admin', password: 'segredo123' });
    expect(run(gate, fakeReq('/login')).out.body).toContain('/api/auth/login');
  });

  it('com o cookie: segue para a API e marca o usuário da requisição', async () => {
    const { gate, users, sessions } = await setup();
    const a = (await users.create({ username: 'admin', password: 'segredo123' })) as { id: string };
    const { token } = sessions.issue(users.get(a.id)!);
    const req = fakeReq('/api/snapshot', { cookie: `${COOKIE}=${token}` });
    expect(run(gate, req).handled).toBe(false);
    expect(requestUser(req)?.username).toBe('admin');
  });
});
