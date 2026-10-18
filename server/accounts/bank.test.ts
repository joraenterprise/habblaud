import { describe, expect, it } from 'vitest';
import { parseProjectJob, ProjectService, runProjectJob } from '../projects/projects';
import { AccountBank } from './bank';

/** Um claude-swap de mentira: N contas, a ativa e o uso de cada uma. */
const fakeSwap = (accounts: Array<{ number: number; five?: number; api?: boolean }>, active = 1) => {
  const calls: string[] = [];
  let current = active;
  return {
    calls,
    swap: {
      list: async () => {
        calls.push('list');
        return {
          ok: true as const,
          data: {
            accounts: accounts.map((a) => ({
              number: a.number,
              email: `c${a.number}@x.com`,
              active: a.number === current,
              usageStatus: a.api ? 'api_key' : 'ok',
              usage: a.api ? null : { fiveHour: { pct: a.five ?? 0 }, sevenDay: { pct: 10 } },
            })),
          },
        };
      },
      switchTo: async (n: number) => {
        calls.push(`switch ${n}`);
        current = n;
        return { ok: true as const, data: {} };
      },
      addToken: async (token: string) => {
        calls.push(`token ${token.slice(0, 10)}`);
        return { ok: true as const, data: { added: { number: 9, email: 'api-key-9@token.local' } } };
      },
      loginStart: async () => ({ ok: true as const, data: { login: { id: '00000000-0000-4000-8000-000000000000', url: 'https://claude.com/cai/oauth/authorize?x=1' } } }),
      loginFinish: async () => ({ ok: true as const, data: { added: { number: 2, email: 'c2@x.com' } } }),
      loginCancel: () => ({ ok: true as const, data: {} }),
      setAlias: async (n: number, name: string) => {
        calls.push(`alias ${n} ${name}`);
        return { ok: true as const, data: {} };
      },
    },
  };
};

const bankWith = (f: ReturnType<typeof fakeSwap>) => {
  const projects = new ProjectService({ run: (job) => runProjectJob(job, { swap: f.swap }) });
  return { bank: new AccountBank({ projects, file: null }), projects };
};

describe('banco de contas no servidor', () => {
  it('lista, avisa e troca só quando alguém pede', async () => {
    const f = fakeSwap([{ number: 1, five: 95 }, { number: 2, five: 20 }]);
    const { bank } = bankWith(f);
    await bank.refresh();
    expect(bank.view()).toMatchObject({ available: true, warning: { active: 1, suggestion: 2 } });
    expect(f.calls).toEqual(['list']);
    await bank.switchTo(2);
    expect(f.calls).toContain('switch 2');
    expect(bank.view().accounts.find((a) => a.active)?.number).toBe(2);
    await expect(bank.switchTo(7)).rejects.toThrow();
  });

  it('com a opção ligada: assinatura esgotada vai para a conta de API e volta depois', async () => {
    const accounts = [{ number: 1, five: 100 }, { number: 2, five: 30 }, { number: 3, api: true }];
    const f = fakeSwap(accounts);
    const { bank } = bankWith(f);
    await bank.refresh();
    expect(f.calls).not.toContain('switch 3');
    bank.setSettings({ autoApi: true });
    await bank.refresh();
    expect(f.calls).toContain('switch 3');
    expect(f.calls).not.toContain('switch 2');
    accounts[0].five = 10;
    await bank.refresh();
    expect(f.calls.at(-2)).toBe('switch 1');
  });

  it('chave de API: só no formato certo e some da memória depois de entregue', async () => {
    expect(parseProjectJob({ kind: 'swap-token', token: 'nao-e-chave' })).toHaveProperty('error');
    const f = fakeSwap([{ number: 1, five: 10 }]);
    const { bank, projects } = bankWith(f);
    const r = await bank.addToken('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.added).toEqual({ number: 9, email: 'api-key-9@token.local' });
    expect(f.calls).toContain('token sk-ant-api');
    await bank.setAlias(1, 'principal');
    expect(f.calls).toContain('alias 1 principal');
    expect(parseProjectJob({ kind: 'swap-alias', target: 1, name: 'com espaço' })).toHaveProperty('error');
    const stored = [...(projects as unknown as { entries: Map<string, unknown> }).entries.values()];
    expect(stored.length).toBeGreaterThan(0);
    expect(JSON.stringify(stored)).not.toContain('sk-ant-api03');
  });
});
