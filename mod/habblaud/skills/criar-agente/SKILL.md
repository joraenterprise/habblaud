---
name: criar-agente
description: Cria (ou edita) um agente personalizado no Habblaud conversando com o usuário — papel, instruções, modelo, ferramentas e permissões — e salva pela API local do Habblaud, para ele aparecer na tela Agentes e no Novo agente (+) do escritório. Use quando o usuário pedir para criar, montar, desenhar, melhorar ou editar um agente do Habblaud, ou disser /criar-agente.
---

# Criar um agente personalizado no Habblaud

Um agente personalizado é um papel salvo no Habblaud: nome, quando usar, instruções (o prompt de sistema), modelo,
ferramentas permitidas, modo de permissão e uma pasta sugerida. No escritório, **Agentes** lista todos e **Usar** (ou o
**+ Novo agente**) começa uma sessão do Claude Code já como ele (`claude --agents <json> --agent <id>`).

Seu trabalho: entrevistar o usuário, escrever um bom agente, mostrar o rascunho, e só depois de um "ok" salvar.

## 1. Confira se o Habblaud está no ar

```bash
PORT="${HABBLAUD_PORT:-4747}"
curl -sS "http://127.0.0.1:$PORT/api/custom-agents"
```

- `{"agents":[...]}`: tudo certo. Guarde a lista: os ids já usados, e se o usuário quer **editar** um deles.
- Erro de conexão: o Habblaud não está rodando. Diga isso e pare (no Docker: `npm run docker:up` na pasta do Habblaud).
- `403` com "desligados": o Habblaud está exposto na rede (`HABBLAUD_BIND`/`HABBLAUD_HOST` fora do loopback) e os
  agentes personalizados ficam desligados. Explique e pare.

## 2. Entreviste (curto, uma rodada por vez)

Use a ferramenta de perguntas (AskUserQuestion) quando houver opções claras; texto livre para o resto. Não pergunte o
que já dá para deduzir do pedido. O que você precisa saber:

1. **Para que serve**: a tarefa típica, o resultado esperado e para quem.
2. **Como trabalha**: passos, critérios de qualidade, formato da entrega, tom.
3. **Limites**: o que nunca deve fazer (ex.: não fazer commit, não mexer em produção, só ler).
4. **Ferramentas**: só leitura (`Read`, `Grep`, `Glob`), edita código (`+ Edit`, `Write`), roda comandos (`+ Bash`, ou
   restrito: `Bash(git:*)`), web (`WebFetch`, `WebSearch`), MCPs (`mcp__<servidor>`). Nenhuma = todas.
5. **Modelo**: `opus` (raciocínio pesado), `sonnet` (equilíbrio), `haiku` (rápido e barato), `fable`, um id completo,
   ou vazio (padrão da conta).
6. **Permissões da sessão**: vazio (padrão da conta), `default` (pergunta tudo), `acceptEdits` (aceita edições),
   `plan` (só planeja). Nunca ofereça modos que pulam permissões: o Habblaud recusa.
7. **Pasta sugerida** (opcional): caminho absoluto do projeto onde ele costuma trabalhar.

## 3. Escreva o agente

- **name**: até 40 caracteres, curto e claro ("Revisor de código").
- **id**: minúsculas, números e hífen, até 40 (se omitir, sai do nome: "revisor-de-codigo"). Não repita um id existente
  ao criar.
- **description**: até 300 caracteres, começando por *quando usar* ("Use para revisar diffs antes do PR...").
- **prompt**: até 8000 caracteres, em segunda pessoa ("Você é..."). Estrutura sugerida:
  - quem é e qual o objetivo;
  - como trabalha (passos numerados);
  - critérios de qualidade e o formato da entrega;
  - limites explícitos (o que não fazer, quando parar e perguntar).
  Seja concreto: troque adjetivos vagos por comportamentos verificáveis.
- **tools**: lista de strings; `[]` = todas.
- **model**, **permissionMode**, **folder**: strings (vazias quando não definidas).

Mostre o rascunho completo ao usuário (nome, id, descrição, modelo, permissões, ferramentas, pasta e as instruções
inteiras) e pergunte se pode salvar ou o que ajustar. Repita até ele aprovar.

## 4. Salve (só depois do "ok")

Escreva o JSON num arquivo temporário (evita problemas de aspas) e envie:

```bash
PORT="${HABBLAUD_PORT:-4747}"
TMP="$(mktemp)"
cat > "$TMP" <<'JSON'
{
  "name": "Revisor de código",
  "id": "revisor-de-codigo",
  "description": "Use para revisar diffs antes de abrir o PR: bugs, segurança e testes faltando.",
  "prompt": "Você é um revisor de código sênior...",
  "model": "opus",
  "tools": ["Read", "Grep", "Glob", "Bash(git:*)"],
  "permissionMode": "plan",
  "folder": ""
}
JSON
# Criar:
curl -sS -X POST -H 'Content-Type: application/json' --data-binary @"$TMP" "http://127.0.0.1:$PORT/api/custom-agents"
# Editar um existente (o id vai na URL):
# curl -sS -X PUT -H 'Content-Type: application/json' --data-binary @"$TMP" "http://127.0.0.1:$PORT/api/custom-agents/revisor-de-codigo"
rm -f "$TMP"
```

- Resposta com o agente (`201` ao criar, `200` ao editar): pronto.
- `409` "já existe": pergunte se é para editar aquele (PUT) ou escolher outro id.
- `400`: a mensagem diz o campo errado; corrija e envie de novo.

Para apagar (só se o usuário pedir, confirmando antes):
`curl -sS -X DELETE -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$PORT/api/custom-agents/<id>"`
(o Habblaud exige `Content-Type: application/json` em tudo que muda estado).

## 5. Conte como usar

Em uma ou duas frases: no Habblaud, abra **Agentes** (ícone de duas pessoas na barra do topo) e clique em **Usar**, ou
escolha o agente no **+ Novo agente**, escolha a pasta e escreva o pedido. Se o botão + não aparecer, o Novo agente está
desligado (precisa de `HABBLAUD_PTY=1` e, no Docker, do `npm run codex:bridge` rodando no computador).
