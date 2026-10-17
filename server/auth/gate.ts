// Portão do login por pessoa (HABBLAUD_LOGIN=1): fica depois do guard (Host/Origin/JSON) e antes da API e dos
// estáticos, na porta principal. Sem sessão válida, a página vai para /login e a API responde 401. Passam sem login:
// a página de login, as rotas de entrar/sair/primeiro acesso, o ícone e o manifesto do app, e as rotas de máquina
// (hooks, plugins, auxiliar do host, /api/health do docker:up), mas estas só com Host local (o próprio computador).
// Também atende a gestão de usuários (/api/users, só administrador) e /api/auth/me (quem está logado).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLocale, tr } from '../../shared/i18n';
import { isLoopbackHost } from '../http/guard';
import { LoginThrottle, readCookie } from '../http/remote';
import { COOKIE, publicUser, type PublicUser, type User, type UserSessions, type UserStore } from './users';

const users = new WeakMap<IncomingMessage, User>();

/** O usuário logado desta requisição (undefined sem login ou com o login desligado). */
export function requestUser(req: IncomingMessage): User | undefined {
  return users.get(req);
}

const PUBLIC_STATIC = /^\/(manifest\.webmanifest|favicon\.ico|assets\/brand\/[\w.@-]+\.(png|svg|ico))$/;

export interface LoginGateDeps {
  users: UserStore;
  sessions: UserSessions;
  /** Rotas de máquina (hooks, plugins, auxiliar do host): passam sem login, mas só com Host local. */
  isMachinePath: (path: string) => boolean;
  /** Cookie com Secure (atrás de HTTPS). */
  secure: boolean;
  throttle?: LoginThrottle;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}

function readBody(req: IncomingMessage, max = 16 * 1024): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) return void fail(new Error('grande demais'));
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        ok(v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
      } catch {
        ok({});
      }
    });
    req.on('error', fail);
  });
}

function cookieHeader(value: string, maxAgeS: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const js = (t: string) => JSON.stringify(t).replace(/</g, '\\u003c');

/** Página de login; sem nenhum usuário, vira o primeiro acesso (cria o administrador). */
export function loginPage(setup: boolean): string {
  const title = setup ? tr('Primeiro acesso: crie o administrador') : tr('Entre com seu usuário');
  const extra = setup
    ? `<label for="n">${esc(tr('Nome'))}</label><input id="n" name="name" autocomplete="name">`
    : '';
  const confirm = setup
    ? `<label for="c">${esc(tr('Repita a senha'))}</label><input id="c" name="confirm" type="password" autocomplete="new-password" required>`
    : '';
  return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(tr('Habblaud · entrar'))}</title>
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #14161f; color: #e8e6df;
         font: 16px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 16px; }
  form { width: 100%; max-width: 380px; background: #1e2130; border: 2px solid #3a3f58; border-radius: 10px; padding: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; color: #f4c95d; }
  p { margin: 0 0 16px; color: #9aa0b8; font-size: 13px; }
  label { display: block; font-size: 13px; color: #9aa0b8; margin: 12px 0 6px; }
  input { width: 100%; padding: 12px; font: inherit; color: inherit; background: #14161f; border: 2px solid #3a3f58; border-radius: 6px; }
  input:focus { outline: none; border-color: #f4c95d; }
  button { width: 100%; margin-top: 20px; padding: 12px; font: inherit; font-weight: 700; color: #14161f; background: #f4c95d;
           border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: wait; }
  #err { min-height: 20px; margin-top: 12px; color: #ff8a80; font-size: 13px; }
</style>
</head>
<body>
<form id="f" autocomplete="on">
  <h1>Habblaud</h1>
  <p>${esc(title)}</p>
  ${extra}
  <label for="u">${esc(tr('Usuário'))}</label>
  <input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
  <label for="p">${esc(tr('Senha'))}</label>
  <input id="p" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required>
  ${confirm}
  <button id="b" type="submit">${esc(setup ? tr('Criar e entrar') : tr('Entrar'))}</button>
  <div id="err" role="alert"></div>
</form>
<script>
  const f = document.getElementById('f'), b = document.getElementById('b'), err = document.getElementById('err');
  const setup = ${setup ? 'true' : 'false'};
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (setup && f.password.value !== f.confirm.value) { err.textContent = ${js(tr('As senhas não conferem.'))}; return; }
    b.disabled = true;
    try {
      const body = { username: f.username.value, password: f.password.value };
      if (setup) body.name = f.name.value;
      const r = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify(body) });
      if (r.ok) { location.replace('/'); return; }
      const j = await r.json().catch(() => ({}));
      err.textContent = j.error || ${js(tr('Não deu para entrar.'))};
    } catch { err.textContent = ${js(tr('Sem conexão com o Habblaud.'))}; }
    b.disabled = false;
  });
</script>
</body>
</html>
`;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

/** Devolve true quando já respondeu; false quando a requisição segue (logada, pública ou de máquina). */
export function createLoginGate(deps: LoginGateDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const throttle = deps.throttle ?? new LoginThrottle();
  const login = async (req: IncomingMessage, res: ServerResponse, setup: boolean) => {
    if (throttle.retryAfter() > 0) {
      req.resume();
      const wait = Math.max(1, throttle.retryAfter());
      return sendJson(res, 429, { error: tr('Muitas tentativas. Tente de novo em {0} s.', [wait]) }, { 'Retry-After': String(wait) });
    }
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    if (!throttle.begin()) return sendJson(res, 429, { error: tr('Muitas tentativas. Tente de novo em instantes.') });
    let ok = false;
    try {
      let user: User | undefined;
      if (setup) {
        // Só sem nenhum usuário: depois do primeiro, quem cria é o administrador.
        if (deps.users.count() > 0) return sendJson(res, 409, { error: tr('o primeiro acesso já foi feito; entre com seu usuário') });
        const r = await deps.users.create({ ...body, role: 'admin' });
        if ('error' in r) return sendJson(res, 400, { error: r.error });
        user = deps.users.get(r.id);
      } else user = await deps.users.authenticate(body.username, body.password);
      if (!user) return sendJson(res, 401, { error: tr('Usuário ou senha incorretos.') });
      ok = true;
      const { token, maxAgeS } = deps.sessions.issue(user);
      sendJson(res, 200, { ok: true, user: publicUser(user) }, { 'Set-Cookie': cookieHeader(token, maxAgeS, deps.secure) });
    } finally {
      throttle.end(ok);
    }
  };

  const manageUsers = async (req: IncomingMessage, res: ServerResponse, path: string, me: User) => {
    const method = req.method ?? 'GET';
    if (me.role !== 'admin') {
      req.resume();
      return sendJson(res, 403, { error: tr('só administradores gerenciam usuários') });
    }
    if (path === '/api/users') {
      if (method === 'GET') return sendJson(res, 200, { users: deps.users.list() });
      if (method === 'POST') {
        const r = await deps.users.create(await readBody(req));
        return 'error' in r ? sendJson(res, 400, { error: r.error }) : sendJson(res, 201, r);
      }
      return sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'GET, POST' });
    }
    const id = decodeURIComponent(path.slice('/api/users/'.length));
    if (method === 'PUT') {
      const r = await deps.users.update(id, await readBody(req));
      return 'error' in r ? sendJson(res, 400, { error: r.error }) : sendJson(res, 200, r);
    }
    if (method === 'DELETE') {
      req.resume();
      if (id === me.id) return sendJson(res, 400, { error: tr('você não pode apagar o próprio usuário') });
      const r = deps.users.remove(id);
      return r === true ? sendJson(res, 200, { ok: true }) : sendJson(res, 400, { error: r.error });
    }
    req.resume();
    return sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'PUT, DELETE' });
  };

  return (req, res, url) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const token = readCookie(req.headers.cookie, COOKIE);
    const me = deps.sessions.verify(token);
    const fail = (err: unknown) => {
      if (!res.headersSent) sendJson(res, 400, { error: String((err as Error)?.message ?? err) });
    };

    if (path === '/api/auth/login' || path === '/api/auth/setup') {
      if (method !== 'POST') sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'POST' });
      else login(req, res, path === '/api/auth/setup').catch(fail);
      return true;
    }
    if (path === '/api/auth/logout') {
      req.resume();
      deps.sessions.revoke(token);
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0, deps.secure) });
      return true;
    }
    if (path === '/login') {
      req.resume();
      if (me) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        res.end();
      } else sendHtml(res, loginPage(deps.users.count() === 0));
      return true;
    }
    if (me) {
      users.set(req, me);
      if (path === '/api/auth/me') {
        req.resume();
        sendJson(res, 200, { user: publicUser(me) satisfies PublicUser });
        return true;
      }
      if (path === '/api/auth/password') {
        // A própria senha: pede a atual (um cookie esquecido num computador não troca a senha de ninguém).
        if (method !== 'POST') sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'POST' });
        else
          readBody(req)
            .then(async (body) => {
              if (!(await deps.users.authenticate(me.username, body.current))) return sendJson(res, 401, { error: tr('a senha atual não confere') });
              const r = await deps.users.update(me.id, { password: body.password });
              if ('error' in r) return sendJson(res, 400, { error: r.error });
              // A sessão antiga deixa de valer com a senha nova: entrega uma nova para quem trocou.
              const { token: next, maxAgeS } = deps.sessions.issue(deps.users.get(me.id)!);
              sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(next, maxAgeS, deps.secure) });
            })
            .catch(fail);
        return true;
      }
      if (path === '/api/users' || path.startsWith('/api/users/')) {
        manageUsers(req, res, path, me).catch(fail);
        return true;
      }
      return false;
    }
    // Sem login: só o que é público ou de máquina (esta, só pelo próprio computador).
    if ((method === 'GET' || method === 'HEAD') && PUBLIC_STATIC.test(path)) return false;
    if (deps.isMachinePath(path) && isLoopbackHost(req.headers.host)) return false;
    req.resume();
    if (path === '/api' || path.startsWith('/api/')) sendJson(res, 401, { error: tr('faça login no Habblaud') });
    else {
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      res.end();
    }
    return true;
  };
}
