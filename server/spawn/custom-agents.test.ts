import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentSlug, agentsJson, parseCustomAgent } from '../../shared/custom-agents';
import { CustomAgentStore } from './custom-agents';
import { cliArgs, parseSpawn, sessionName, SpawnService, spawnUrl, type CliRunner, type Opener } from './spawn';

const base = { name: 'Revisor de Código', description: 'Revisa diffs', prompt: 'Você revisa código.' };

describe('agentes personalizados: validação', () => {
  it('gera o id pelo nome e limpa os campos', () => {
    expect(agentSlug('Revisor de Código!')).toBe('revisor-de-codigo');
    const a = parseCustomAgent({ ...base, tools: 'Read, Grep, Read', model: 'opus' });
    expect(a).toEqual({ id: 'revisor-de-codigo', name: 'Revisor de Código', description: 'Revisa diffs', prompt: 'Você revisa código.', model: 'opus', tools: ['Read', 'Grep'], permissionMode: '', folder: '' });
  });

  it('recusa campos faltando ou inválidos', () => {
    expect(parseCustomAgent({ ...base, name: '' })).toHaveProperty('error');
    expect(parseCustomAgent({ ...base, description: '' })).toHaveProperty('error');
    expect(parseCustomAgent({ ...base, prompt: ' ' })).toHaveProperty('error');
    expect(parseCustomAgent({ ...base, id: 'Com Espaço' })).toHaveProperty('error');
    expect(parseCustomAgent({ ...base, permissionMode: 'bypassPermissions' })).toHaveProperty('error');
    expect(parseCustomAgent({ ...base, folder: 'relativa' })).toHaveProperty('error');
    expect(parseCustomAgent({ ...base, model: 'a b' })).toHaveProperty('error');
  });

  it('monta o JSON do --agents só com o que foi definido', () => {
    const a = parseCustomAgent(base) as Exclude<ReturnType<typeof parseCustomAgent>, { error: string }>;
    expect(JSON.parse(agentsJson(a))).toEqual({ 'revisor-de-codigo': { description: 'Revisa diffs', prompt: 'Você revisa código.' } });
    expect(JSON.parse(agentsJson({ ...a, tools: ['Read'], model: 'haiku' }))['revisor-de-codigo']).toEqual({ description: 'Revisa diffs', prompt: 'Você revisa código.', tools: ['Read'], model: 'haiku' });
  });
});

describe('agentes personalizados: cadastro', () => {
  it('cria, edita, recusa duplicado, apaga e persiste', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'habblaud-agents-')), 'custom-agents.json');
    let now = 1000;
    const s = new CustomAgentStore(file, () => now);
    const c = s.save(base);
    expect(c).toMatchObject({ created: true, agent: { id: 'revisor-de-codigo', createdAt: 1000 } });
    expect(s.save(base)).toMatchObject({ status: 409 });
    now = 2000;
    expect(s.save({ ...base, id: 'outro', prompt: 'Novo' }, 'revisor-de-codigo')).toMatchObject({ agent: { id: 'revisor-de-codigo', prompt: 'Novo', createdAt: 1000, updatedAt: 2000 } });
    expect(s.save(base, 'nao-existe')).toMatchObject({ status: 404 });
    expect(JSON.parse(readFileSync(file, 'utf8')).agents).toHaveLength(1);
    const again = new CustomAgentStore(file);
    again.load();
    expect(again.get('revisor-de-codigo')?.prompt).toBe('Novo');
    expect(again.remove('revisor-de-codigo')).toBe(true);
    expect(again.remove('revisor-de-codigo')).toBe(false);
    expect(again.list()).toEqual([]);
  });
});

describe('novo agente com agente personalizado', () => {
  const agent = { id: 'rev', name: 'Revisor', description: 'Revisa', prompt: 'Você revisa.', model: 'opus', tools: ['Read'], permissionMode: 'plan' as const };

  it('passa a definição, o agente e o modo de permissão ao claude', () => {
    const args = cliArgs({ folder: '/p', prompt: 'olhe o PR', agent });
    expect(args).toEqual(['--bg', '-n', 'Habblaud · Revisor: olhe o PR', '--agents', agentsJson(agent), '--agent', 'rev', '--permission-mode', 'plan', '--', 'olhe o PR']);
    expect(sessionName('', 'Revisor')).toBe('Habblaud · Revisor');
  });

  it('no link do app, as instruções vão antes do pedido', () => {
    const q = new URL(spawnUrl({ folder: '/p', prompt: 'olhe', agent }).replace('claude://', 'http://x/')).searchParams.get('q');
    expect(q).toBe('Você revisa.\n\n---\n\nolhe');
  });

  it('o auxiliar recebe a definição inteira e a valida', () => {
    expect(parseSpawn({ folder: '/p', prompt: 'x', agent })).toEqual({ folder: '/p', prompt: 'x', agent });
    expect(parseSpawn({ folder: '/p', prompt: 'x', agent: { ...agent, prompt: '' } })).toHaveProperty('error');
  });

  it('troca o id pela definição do cadastro e recusa id desconhecido', async () => {
    const store = new CustomAgentStore(null);
    store.save({ ...base, id: 'rev' });
    const seen: unknown[] = [];
    const cli: CliRunner = async (req) => {
      seen.push(req);
      return { ok: true, id: 'abc' };
    };
    const opener: Opener = async () => ({ ok: true });
    const s = new SpawnService({ opener, cli, folderProblem: () => undefined, customAgent: (id) => store.get(id), newId: () => 's1' });
    expect(s.submit({ folder: '/p', prompt: 'x', agent: 'nao-existe' })).toMatchObject({ error: 'invalid' });
    expect(s.submit({ folder: '/p', prompt: 'x', agent: 'rev' })).toMatchObject({ spawn: { id: 's1' } });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(seen[0]).toMatchObject({ folder: '/p', prompt: 'x', agent: { id: 'rev', name: 'Revisor de Código', prompt: 'Você revisa código.' } });
    expect(s.get('s1')).toMatchObject({ status: 'opened', how: 'cli' });
  });

  it('na fila do auxiliar (Docker), o pedido leva a definição', () => {
    const store = new CustomAgentStore(null);
    store.save({ ...base, id: 'rev' });
    const s = new SpawnService({ customAgent: (id) => store.get(id), newId: () => 'q1' });
    s.poll();
    s.submit({ folder: '/p', prompt: 'x', agent: 'rev' });
    expect(s.poll()[0]).toMatchObject({ id: 'q1', agent: { id: 'rev', description: 'Revisa diffs' } });
  });
});
