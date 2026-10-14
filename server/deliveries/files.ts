// Arquivos das entregas: o que pode ser mostrado no escritório. Só arquivos que o próprio agente entregou (o servidor
// só pede caminhos que estão numa entrega) e, mesmo assim, só tipos de ver (imagem, PDF, vídeo, página, texto) e nunca
// algo com cara de segredo (.ssh, .env, chaves, credenciais...). Quem lê é o servidor (modo Node, ou pasta montada no
// Docker) ou o auxiliar do host (scripts/codex-bridge.ts), que confere tudo de novo antes de ler.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DeliveryAttachmentKind } from '../../shared/types';
import { tr } from '../../shared/i18n';

export const DELIVERY_FILE_MAX_BYTES = 25 * 1024 * 1024;

const TYPES: Readonly<Record<string, { kind: DeliveryAttachmentKind; type: string }>> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  pdf: { kind: 'pdf', type: 'application/pdf' },
  mp4: { kind: 'video', type: 'video/mp4' },
  mov: { kind: 'video', type: 'video/quicktime' },
  webm: { kind: 'video', type: 'video/webm' },
  html: { kind: 'page', type: 'text/html; charset=utf-8' },
  htm: { kind: 'page', type: 'text/html; charset=utf-8' },
  md: { kind: 'text', type: 'text/plain; charset=utf-8' },
  txt: { kind: 'text', type: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', type: 'text/plain; charset=utf-8' },
  log: { kind: 'text', type: 'text/plain; charset=utf-8' },
  tsv: { kind: 'text', type: 'text/plain; charset=utf-8' },
  json: { kind: 'text', type: 'text/plain; charset=utf-8' },
  jsonl: { kind: 'text', type: 'text/plain; charset=utf-8' },
  yaml: { kind: 'text', type: 'text/plain; charset=utf-8' },
  yml: { kind: 'text', type: 'text/plain; charset=utf-8' },
  xml: { kind: 'text', type: 'text/plain; charset=utf-8' },
  toml: { kind: 'text', type: 'text/plain; charset=utf-8' },
  sql: { kind: 'text', type: 'text/plain; charset=utf-8' },
  ts: { kind: 'text', type: 'text/plain; charset=utf-8' },
  tsx: { kind: 'text', type: 'text/plain; charset=utf-8' },
  js: { kind: 'text', type: 'text/plain; charset=utf-8' },
  jsx: { kind: 'text', type: 'text/plain; charset=utf-8' },
  mjs: { kind: 'text', type: 'text/plain; charset=utf-8' },
  cjs: { kind: 'text', type: 'text/plain; charset=utf-8' },
  py: { kind: 'text', type: 'text/plain; charset=utf-8' },
  rb: { kind: 'text', type: 'text/plain; charset=utf-8' },
  go: { kind: 'text', type: 'text/plain; charset=utf-8' },
  rs: { kind: 'text', type: 'text/plain; charset=utf-8' },
  java: { kind: 'text', type: 'text/plain; charset=utf-8' },
  kt: { kind: 'text', type: 'text/plain; charset=utf-8' },
  cs: { kind: 'text', type: 'text/plain; charset=utf-8' },
  php: { kind: 'text', type: 'text/plain; charset=utf-8' },
  c: { kind: 'text', type: 'text/plain; charset=utf-8' },
  h: { kind: 'text', type: 'text/plain; charset=utf-8' },
  cpp: { kind: 'text', type: 'text/plain; charset=utf-8' },
  swift: { kind: 'text', type: 'text/plain; charset=utf-8' },
  vue: { kind: 'text', type: 'text/plain; charset=utf-8' },
  svelte: { kind: 'text', type: 'text/plain; charset=utf-8' },
  css: { kind: 'text', type: 'text/plain; charset=utf-8' },
  scss: { kind: 'text', type: 'text/plain; charset=utf-8' },
  sh: { kind: 'text', type: 'text/plain; charset=utf-8' },
  ps1: { kind: 'text', type: 'text/plain; charset=utf-8' },
  bat: { kind: 'text', type: 'text/plain; charset=utf-8' },
  prisma: { kind: 'text', type: 'text/plain; charset=utf-8' },
  graphql: { kind: 'text', type: 'text/plain; charset=utf-8' },
  mermaid: { kind: 'text', type: 'text/plain; charset=utf-8' },
  mmd: { kind: 'text', type: 'text/plain; charset=utf-8' },
  xlsx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  xls: { kind: 'file', type: 'application/vnd.ms-excel' },
  odt: { kind: 'file', type: 'application/vnd.oasis.opendocument.text' },
  ods: { kind: 'file', type: 'application/vnd.oasis.opendocument.spreadsheet' },
  docx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  zip: { kind: 'file', type: 'application/zip' },
};

/** Pastas e nomes que nunca saem, mesmo que um agente os "entregue" (texto injetado num transcript, por exemplo). */
const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.config\/gh|\.config\/gcloud|Keychains|\.habblaud\/remote-tls)(\/|$)/i;
const SECRET_NAMES = /(^|\/)(\.env[^/]*|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|[^/]*(secret|credential|password|senha|token)[^/]*)$/i;

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Tipo de visualização e Content-Type, ou undefined se a extensão não é de ver. */
export function fileType(path: string): { kind: DeliveryAttachmentKind; type: string } | undefined {
  return TYPES[extensionOf(path)];
}

/** Caminho absoluto do Unix (/...) ou do Windows (C:\... ou C:/...). */
export function isAbsoluteAnyOs(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

/** Motivo para NÃO mostrar o caminho (só olhando o texto), ou undefined. */
export function pathProblem(path: string): string | undefined {
  // As regras olham o caminho com barras normais: as do Windows também passam por elas.
  const p = path.replace(/\\/g, '/');
  if (!path || path.includes('\0') || !isAbsoluteAnyOs(path) || /(^|\/)\.\.(\/|$)/.test(p)) return tr('caminho inválido');
  if (!fileType(path)) return tr('tipo de arquivo que não se mostra aqui');
  if (SECRET_DIRS.test(p) || SECRET_NAMES.test(p)) return tr('arquivo protegido');
  return undefined;
}

/** Confere no disco (links resolvidos, tamanho, arquivo comum). Devolve o caminho real ou o motivo. */
export function checkFile(
  path: string,
  fs: { realpath(p: string): string; stat(p: string): { isFile(): boolean; size: number } } = { realpath: realpathSync, stat: statSync },
): { path: string; size: number } | { error: string } {
  const bad = pathProblem(path);
  if (bad) return { error: bad };
  let real: string;
  let st: { isFile(): boolean; size: number };
  try {
    real = fs.realpath(path);
    st = fs.stat(real);
  } catch {
    return { error: tr('arquivo não encontrado') };
  }
  const realBad = pathProblem(real);
  if (realBad) return { error: realBad };
  if (!st.isFile()) return { error: tr('não é um arquivo') };
  if (st.size > DELIVERY_FILE_MAX_BYTES) return { error: tr('arquivo grande demais para ver aqui') };
  return { path: real, size: st.size };
}

/** Pastas temporárias onde os agentes guardam rascunhos e prints (a do sistema e as de sempre no macOS e no Linux). */
export function tempRoots(): string[] {
  const out = new Set<string>(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']);
  try {
    out.add(realpathSync(tmpdir()));
  } catch {
    out.add(tmpdir());
  }
  return [...out];
}

/**
 * O arquivo (caminho real) está numa pasta que o auxiliar do host pode ler: uma pasta de projeto que alguma conta do
 * Claude Code conhece (ela, ou uma acima dela, tem <conta>/projects/<pasta codificada>) ou uma das `roots` (pastas
 * temporárias, anexos do Habblaud). Assim um pedido vindo do container não alcança o resto do computador.
 */
export function insideKnownFolder(
  path: string,
  opts: { accountDirs: readonly string[]; roots: readonly string[]; exists?: (p: string) => boolean },
): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const target = norm(path);
  if (opts.roots.some((r) => r && target.startsWith(`${norm(r)}/`))) return true;
  const exists = opts.exists ?? existsSync;
  // Mesma codificação de sources/watcher.ts (encodeCwd): todo caractere não alfanumérico vira "-".
  // No Windows a pasta tem barras invertidas e letra de unidade (C:\Users\voce -> C--Users-voce).
  for (let dir = dirname(path); dir.split(/[\\/]/).filter(Boolean).length >= 2 && dir !== dirname(dir); dir = dirname(dir)) {
    const encoded = dir.replace(/[^a-zA-Z0-9]/g, '-');
    if (opts.accountDirs.some((acc) => exists(join(acc, 'projects', encoded)))) return true;
  }
  return false;
}
