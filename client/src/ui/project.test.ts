import { describe, expect, it } from 'vitest';
import { parentFolders, repoName } from './project';

describe('novo projeto: sugestões', () => {
  it('sugere as pastas-mãe dos projetos recentes, sem as temporárias', () => {
    expect(
      parentFolders([
        'C:\\Users\\f\\AppData\\Roaming\\Claude\\scratch-workspaces\\abc\\scratch-1',
        'C:\\Users\\f\\habblaud',
        'C:\\Users\\f\\beyond\\SIAL\\sial',
        'C:\\Users\\f\\beyond\\sgcp',
        '/tmp/x/y',
      ]),
    ).toEqual(['C:\\Users\\f', 'C:\\Users\\f\\beyond\\SIAL', 'C:\\Users\\f\\beyond']);
  });

  it('nome da pasta de um clone', () => {
    expect(repoName('dono/repo')).toBe('repo');
    expect(repoName('git@github.com:dono/repo.git')).toBe('repo');
  });
});
