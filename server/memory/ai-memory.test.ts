import { describe, expect, it } from 'vitest';
import { AiMemoryPublisher, aiMemoryConfig, candidateProjects, folderProject, pageBody, pagePath, type MemoryTurn, type Rpc } from './ai-memory';

const delivery = (over: Partial<MemoryTurn> = {}): MemoryTurn => ({
  id: '.claude:a045a78c-622c:u1',
  account: '.claude',
  sessionId: 'a045a78c-622c-4e6a-961e-c19d0afd7807',
  agentName: 'Augusto',
  project: 'C:\\Users\\filip\\rollcake',
  request: 'Leia o relatório…',
  fullRequest: 'Leia o relatório e lembre: a Rollcake é ME no Simples Nacional e prioriza a CAIXA.',
  headline: 'As duas melhores oportunidades',
  text: '## Resumo\n- CAIXA (nota 8)\n- FACEPE (nota 8,5)',
  startedAt: Date.UTC(2026, 9, 16, 23, 43),
  finishedAt: Date.UTC(2026, 9, 16, 23, 44),
  tools: 3,
  edited: 1,
  attachments: [],
  written: ['C:\\Users\\filip\\rollcake\\oportunidades\\2026-10-14-relatorio.html'],
  ...over,
});

describe('ai-memory: configuração e nomes', () => {
  it('liga só com uma URL http(s)', () => {
    expect(aiMemoryConfig({})).toBeUndefined();
    expect(aiMemoryConfig({ HABBLAUD_AI_MEMORY_URL: 'http://host.docker.internal:49374/', HABBLAUD_AI_MEMORY_TOKEN: ' t ' })).toEqual({ url: 'http://host.docker.internal:49374', token: 't' });
  });

  it('projeto pela pasta e ordem de tentativa (pasta, remote do git, resto)', () => {
    expect(folderProject('C:\\Users\\filip\\Meu Projeto\\')).toBe('meu-projeto');
    expect(candidateProjects('C:\\Users\\filip\\habblaud', ['rollcake', 'scratch', 'marmottajr-habblaud', 'habblaud'])).toEqual(['habblaud', 'marmottajr-habblaud', 'rollcake', 'scratch']);
  });

  it('página com o pedido inteiro, a resposta e os arquivos', () => {
    const d = delivery();
    expect(pagePath(d)).toMatch(/^habblaud\/pedidos\/2026-10-16-a045a78c-[0-9a-f]{10}\.md$/);
    // Pedidos diferentes da mesma sessão nunca dividem a página.
    expect(pagePath(delivery({ id: '.claude:a045a78c-622c:u2' }))).not.toBe(pagePath(d));
    const body = pageBody(d);
    expect(body).toContain('ME no Simples Nacional e prioriza a CAIXA');
    expect(body).toContain('## Resposta final');
    expect(body).toContain('CAIXA (nota 8)');
    expect(body).toContain('2026-10-14-relatorio.html');
  });
});

describe('ai-memory: publicação', () => {
  const setup = (accept: (project: string, withSession: boolean) => boolean, list = [delivery()]) => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc: Rpc = async (_tool, args) => {
      calls.push(args);
      return accept(String(args.project), 'session_id' in args) ? { ok: true, text: '{}' } : { ok: false, error: `session ${String(args.session_id)} is not a session of the project this page is written to`, code: -32602 };
    };
    const pub = new AiMemoryPublisher({ file: null, rpc, adminGet: async () => ({ projects: [{ workspace_name: 'default', project_name: 'scratch' }, { workspace_name: 'default', project_name: 'rollcake' }] }), deliveries: async () => list });
    return { pub, calls };
  };

  it('grava no projeto que aceita a sessão e não publica de novo', async () => {
    const { pub, calls } = setup((p) => p === 'rollcake');
    expect(await pub.round()).toBe(1);
    expect(calls[0]).toMatchObject({ workspace: 'default', project: 'rollcake', session_id: 'a045a78c-622c-4e6a-961e-c19d0afd7807', path: pagePath(delivery()) });
    expect(await pub.round()).toBe(0);
    expect(pub.info()).toMatchObject({ enabled: true, published: 1 });
  });

  it('sessão que os hooks não capturaram vai para o projeto da pasta, sem a sessão', async () => {
    const { pub, calls } = setup((_p, withSession) => !withSession);
    expect(await pub.round()).toBe(1);
    expect(calls.at(-1)).toMatchObject({ project: 'rollcake' });
    expect(calls.at(-1)).not.toHaveProperty('session_id');
  });

  it('servidor fora do ar: não marca como publicado', async () => {
    const rpc: Rpc = async () => ({ ok: false, error: 'fetch failed' });
    const pub = new AiMemoryPublisher({ file: null, rpc, adminGet: async () => ({ projects: [] }), deliveries: async () => [delivery()] });
    expect(await pub.round()).toBe(0);
    expect(pub.info()).toMatchObject({ published: 0, lastError: 'fetch failed' });
  });
});
