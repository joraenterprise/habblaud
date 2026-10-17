import { describe, expect, it } from 'vitest';
import { apiFallbackDecision, needsWarning, parseAdded, parseLoginUrl, parseSwapAccounts, suggestTarget, type SwapAccount } from './swap';

const acc = (number: number, five: number | undefined, over: Partial<SwapAccount> = {}): SwapAccount => ({
  number,
  email: `c${number}@x.com`,
  active: false,
  status: 'ok',
  ...(five !== undefined ? { fiveHour: { pct: five }, sevenDay: { pct: Math.min(five, 30) } } : {}),
  ...over,
});

describe('banco de contas: leitura', () => {
  it('lê o cswap list --json e ignora o que não conhece', () => {
    const list = parseSwapAccounts({
      schemaVersion: 1,
      accounts: [
        { number: 2, email: 'b@x.com', active: false, usageStatus: 'api_key', usage: null },
        { number: 1, email: 'a@x.com', organizationName: 'Rollcake', active: true, usageStatus: 'ok', usage: { fiveHour: { pct: 49, resetsAt: '2026-10-17T04:29:59Z' }, sevenDay: { pct: 24 } }, token: 'segredo' },
        { number: 'x', email: 'ruim' },
      ],
    });
    expect(list.map((a) => a.number)).toEqual([1, 2]);
    expect(list[0]).toEqual({ number: 1, email: 'a@x.com', organization: 'Rollcake', active: true, status: 'ok', fiveHour: { pct: 49, resetsAt: '2026-10-17T04:29:59Z' }, sevenDay: { pct: 24 } });
    expect(JSON.stringify(list)).not.toContain('segredo');
    expect(list[1].status).toBe('api_key');
    expect(parseSwapAccounts('lixo')).toEqual([]);
  });

  it('lê o "Added Account" e o link do login', () => {
    expect(parseAdded('Added Account 3: maria@x.com [Org]')).toEqual({ number: 3, email: 'maria@x.com' });
    expect(parseLoginUrl("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=a&state=b\nPaste code")).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=a&state=b');
    expect(parseLoginUrl('visit https://evil.example/oauth/authorize?x=1')).toBeUndefined();
  });
});

describe('banco de contas: aviso e sugestão', () => {
  it('avisa acima de 90% e sugere a assinatura com mais folga (nunca API, desativada ou a ativa)', () => {
    const list = [acc(1, 95, { active: true }), acc(2, 40), acc(3, 10, { disabled: true }), acc(4, undefined, { status: 'api_key' }), acc(5, 20)];
    expect(needsWarning(list)?.number).toBe(1);
    expect(suggestTarget(list)?.number).toBe(5);
    expect(needsWarning([acc(1, 50, { active: true })])).toBeUndefined();
    expect(suggestTarget([acc(1, 95, { active: true }), acc(2, 92)])).toBeUndefined();
  });
});

describe('banco de contas: troca automática só para a API', () => {
  it('assinatura esgotada vai para a conta de API, nunca para outra assinatura', () => {
    expect(apiFallbackDecision([acc(1, 100, { active: true }), acc(2, 5)], {})).toEqual({ action: 'none' });
    expect(apiFallbackDecision([acc(1, 100, { active: true }), acc(2, 5), acc(3, undefined, { status: 'api_key' })], {})).toEqual({ action: 'to-api', target: 3, returnTo: 1 });
    expect(apiFallbackDecision([acc(1, 99, { active: true }), acc(3, undefined, { status: 'api_key' })], {})).toEqual({ action: 'none' });
  });

  it('volta para a assinatura de onde saiu quando ela tem folga', () => {
    const onApi = (five: number) => [acc(1, five), acc(2, 5), acc(3, undefined, { status: 'api_key', active: true })];
    expect(apiFallbackDecision(onApi(85), { returnTo: 1 })).toEqual({ action: 'none' });
    expect(apiFallbackDecision(onApi(20), { returnTo: 1 })).toEqual({ action: 'back', target: 1 });
    // Sem saber de onde veio, não volta para nenhuma (nem para a 2, com folga).
    expect(apiFallbackDecision(onApi(20), {})).toEqual({ action: 'none' });
  });
});
