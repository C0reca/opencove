# FORK_PLAN — C0reca/opencove

Fork de `DeadWaveWave/opencove` (remote `upstream`), base `v0.4.0-nightly.20261018.1`.
Objetivo: três funcionalidades de fluxo de trabalho com GitHub Issues, com a menor
divergência possível do núcleo para continuar a fazer merge do upstream.

Issues: plano #1 · F1 #2 · F2 #3 (#5, #6, #7) · F3 #4 (#8, #9).

Ordem de preferência para onde o código vive: **(a) plugin → (b) CLI → (c) núcleo**.

## 1. O que existe hoje

### 1.1 CLI (`src/app/cli`)

- Binário `opencove` = `src/app/cli/opencove.mjs` (ESM, não empacotado). Em dev:
  `pnpm opencove <cmd>` com `pnpm dev` a correr.
- Transporte: `POST http://host:port/invoke` com `Bearer <token>` e
  `{kind,id,payload}` para a Control Surface. O endpoint é descoberto em
  `<userData>/control-surface.json` (procura `opencove-dev` primeiro, depois `opencove`).
- **Não está no PATH dos terminais por omissão.** Os PTYs só recebem shims de
  telemetria para `claude/codex`. Para instalar: Settings → Worker → CLI →
  **Install CLI** (escreve um wrapper em `/opt/homebrew/bin` ou `/usr/local/bin`
  ou `~/.local/bin`; funciona em dev).
- Comandos relevantes que já existem:
  - `project list`, `space list|get`, `worktree list|create --space|archive`
  - `node list|get|create note|task|website|agent|terminal`,
    `node update note|task|website` (task: `--status todo|doing|ai_done|done`), `node delete`
  - `session run-agent|get|final|kill`
  - `plugin install|enable|run <id> <cmd> --params <json>|skill <id> <skill>|…`
- Para acrescentar um comando: ramo em `opencove.mjs` ou num `commands/*.mjs`, mais
  `controlSurface.register(id, {kind, validate, handle})` em
  `src/app/main/controlSurface/handlers/*`. Testes em `tests/unit/app/cli*.spec.ts`.

### 1.2 Plugins (`src/contexts/plugins`, `docs/plugins`)

- Os plugins são **pacotes externos instalados**. Nenhum vem compilado na app e não
  há registo no núcleo: **um plugin novo não altera nenhum ficheiro do núcleo**.
  Instalação: `opencove plugin install <dir>` ou `install-git <url>`.
- Manifesto `opencove.plugin.json` (`apiVersion: 1`, ainda instável). O backend
  `main.mjs` corre num processo Node separado com acesso total (fs, child_process,
  rede); não há sandbox de permissões.
- O que um plugin pode fazer:
  - **Sidebar** por projeto: árvore renderizada pelo host, preenchida por um
    `itemsCommand` do backend. Os itens podem disparar comandos.
  - **Janela/nó** com `view` HTML em iframe.
  - **Comandos** (`target: plugin|window`, nos menus commandCenter, canvas, node,
    space ou sidebar), invocáveis pela CLI com `opencove plugin run`.
  - **Skills**: um `SKILL.md` lido com `opencove plugin skill`.
  - **Host API**:
    - `target.list` (projetos e Spaces)
    - `operations.start` (corre `gh …` no diretório do projeto, incluindo mounts remotos)
    - `nodes.create` (task e agent, entre outros)
    - `agents.launch`
    - `agents.get` → `{node, session, agentState}`
    - `events.subscribe`
- Só existe um exemplo: `docs/plugins/examples/hello-clock`.

### 1.3 Nós Task e Agent

- `TaskNodeData`: `requirement` (corpo), `status todo|doing|ai_done|done`,
  `priority`, `tags`, `linkedAgentNodeId`, `agentSessions`. **Não há campo para
  issue ou URL**; uma ligação externa só cabe em `tags` ou no `requirement`.
- "Correr agente a partir da tarefa" existe **só no renderer**
  (`useTaskActions.agentSession.run.ts`). O prompt é `requirement.trim()`. A ação
  liga os dois lados (`agent.taskId` e `task.linkedAgentNodeId`) e passa a tarefa
  para `doing`.
- Pela Control Surface, `node.create agent` lança o agente mas cria-o com
  `taskId: null` (`nodeDataFactory.ts`), e `node.update` não permite ligar.
  **Esta é a única lacuna real do núcleo.**
- Worktrees são **por Space**, não por tarefa: `gitWorktree.create` mais
  `space.directoryPath`. O agente herda o diretório do Space. `space.createChild`
  existe na Control Surface, mas não na CLI nem na Host API.
- Estados do agente:
  - `AgentRuntimeStatus` = `running|standby|waiting|exited|failed|stopped|restoring`.
    O renderer arbitra este estado e o estado de runtime não é persistido.
  - Sinais de hooks do Claude Code: `working|waiting|done`. Chegam por um ficheiro
    `--settings` temporário por lançamento, um relay e `POST /hooks/claude`.
  - Leitura a partir de fora: `agents.get().agentState` na Host API dos plugins.
    `node get` dá o estado persistido, que não serve para isto.
- Já existe integração `gh` no núcleo (`src/contexts/integration/infrastructure/github`),
  mas só para PRs. Não há listagem de issues.

## 2. Desenho por funcionalidade

Todo o código do fork vive num plugin novo, `plugins/github-issues/` (pasta de topo
que o upstream não usa). Os testes ficam em `tests/unit/forkPlugins/`. O núcleo só
recebe uma alteração pequena (F2.b).

### F1 — Painel de GitHub Issues → **plugin** (#2)

- `contributes.sidebar`: uma secção "Issues" por projeto. O `itemsCommand` corre
  `gh issue list --state open --json number,title,url,labels,assignees,updatedAt`
  através de `host.operations.start` no diretório do projeto. Isto respeita mounts
  remotos e a autenticação `gh` da máquina.
- Comando de backend `issues.list` (com `{projectId?}`). Com vários projetos,
  agrega e deduplica por repositório (`gh repo view --json nameWithOwner`).
- Se o `gh` não estiver instalado ou autenticado, ou o projeto não for um repositório
  GitHub, a secção mostra um item informativo em vez de rebentar.
- **Porquê plugin:** a sidebar, os processos e o alvo por projeto já são API pública.
  Fica com zero ficheiros do núcleo alterados.

### F2 — Atribuir issue a agente → **plugin + 1 alteração pequena no núcleo** (#3)

- **F2.a (plugin, #5):** comando `issue.assign {projectId, number, provider?, worktree?}`,
  disponível na sidebar (item da issue) e pela CLI. Faz o seguinte:
  1. `gh issue view N --json title,body,url,comments`.
  2. `host.nodes.create({kind:'task'})` com título `#N título`. O requirement
     leva o corpo da issue, o URL e o critério "abrir PR com `Fixes #N`". As tags
     são `issue:owner/repo#N`, que é a ligação estável usada para reencontrar a
     tarefa (idempotente: se já existe uma tarefa com esta tag, reutiliza-a).
  3. `host.agents.launch({prompt: requirement, provider:'claude-code'})`.
  4. Põe a tarefa em `doing`.
- **F2.b (núcleo, isolado, #6):** campo opcional `taskNodeId` no `node.create agent`
  (Control Surface e `host.agents.launch`). Liga os dois lados como a ação do
  renderer já faz, com aresta visível e o fluxo "re-run" da tarefa.
  - Ficheiros: `nodeDataFactory.ts`, `nodeCreateCommit.ts`, a validação em
    `nodeControlHandlers.ts`, `pluginCanvasHost.ts` e a flag `--task` em
    `commands/nodeControl.mjs`. Estimo cerca de 60 linhas mais testes.
  - É genérico, por isso **é candidato a PR no upstream**. Se for aceite, a
    divergência desaparece.
  - Sem F2.b tudo funciona, mas a tarefa e o agente ficam sem aresta.
- **F2.c (worktree por issue, #7):** cria um Space filho por issue, com worktree no
  branch `issue-N-slug`, e lança o agente nesse Space.
  - Precisa de criar Spaces a partir de fora. Opção preferida: o comando de CLI
    `space create --parent --name` (camada CLI, envolve o `space.createChild` que
    já existe), seguido do `worktree create --space` já existente.
  - O plugin chama a CLI pública. A Host API não expõe Spaces e não vamos
    alargá-la no fork.
  - **Antes de implementar é preciso uma Feasibility Check.** Confirmar que
    `space.createChild` com worktree e agente funciona sem o renderer aberto, e
    como é o arquivo e limpeza da worktree quando a issue fecha.

### F3 — Agente coordenador → **plugin (comandos + skill), sem CLI nova** (#4: #8 comandos, #9 skill)

- O coordenador é um agente Claude Code que usa `opencove plugin run github-issues <cmd>`:
  - `issues.list`: igual a F1.
  - `issue.assign`: igual a F2. Aceita `worktree: true` quando F2.c existir.
  - `agents.status`: percorre as tarefas com tag `issue:*` e, para o agente de cada
    uma, devolve `{issue, taskStatus, nodeId, runtimeStatus, agentState}`. O
    `agentState` vem de `host.agents.get`: working, waiting (à espera de input),
    done ou null.
  - `issue.close {number, evidence, pr}`: fecha só com prova. Exige `pr`, e o PR
    tem de estar `MERGED` (ou, se não houver PR, `evidence` não vazia mais
    `force:true`). Comenta a evidência na issue, faz `gh issue close` e passa a
    tarefa para `done`.
- **Skill** `issue-coordinator/SKILL.md` no plugin. Descreve o playbook: listar,
  priorizar, atribuir, monitorizar e fechar com prova, e quando parar e pedir input.
- Comando `coordinator.launch` (menu da sidebar/space): lança um agente com o
  prompt da skill.
- **Pré-requisito:** a CLI `opencove` tem de estar no PATH dos terminais. É uma
  ação manual única: Settings → Worker → CLI → Install CLI.
- **Porquê sem CLI nova:** `plugin run` já é a ponte CLI → backend do plugin,
  com JSON, timeout e erros estruturados.

## 3. Ficheiros a tocar

| Onde | Ficheiros | Conflito com upstream |
| --- | --- | --- |
| Plugin | `plugins/github-issues/**` (manifest, `main.mjs`, `lib/*.mjs`, skill, README) | nenhum (pasta nova) |
| Testes | `tests/unit/forkPlugins/githubIssues*.spec.ts` | nenhum (ficheiros novos) |
| Núcleo F2.b | `nodeDataFactory.ts`, `nodeCreateCommit.ts`, `nodeControlHandlers.ts`, `pluginCanvasHost.ts`, `commands/nodeControl.mjs`, `docs/cli/CANVAS_NODE_CONTROL.md`, `docs/plugins/CANVAS_API.md` | médio: zona ativa no upstream |
| CLI F2.c | `src/app/cli/opencove.mjs` (ou `commands/space.mjs` novo), `usage.mjs` | baixo/médio: `opencove.mjs` é um if/else longo |
| Docs | `docs/FORK_PLAN.md` | nenhum |

## 4. Riscos

1. **`apiVersion: 1` do plugin pode mudar** de forma incompatível. Mitigação: um teste
   de fumo do plugin (manifesto válido mais comandos puros) corre em cada merge do
   upstream, e o plugin depende só dos métodos documentados em `HOST_API.md`.
2. **Conflitos de F2.b** nos ficheiros de nodeControl. Mitigação: um único commit
   isolado `feat(core): …`, proposto ao upstream.
3. **`agentState` é observação, não verdade.** "done" não quer dizer que a tarefa
   está feita. Por isso o fecho exige PR merged ou evidência explícita, nunca só o
   estado.
4. **Plugin sem sandbox:** o backend corre `gh` com as credenciais da máquina. Só
   corre comandos `gh` fixos (sem shell, argumentos em array) e valida `number` como
   inteiro e `projectId` pela Host API.
5. **Rate limit e latência do `gh`** com muitos projetos. Cache curta (60 s) por
   repositório no backend, mais refresh manual.
6. **CHANGELOG.md e `main`:** o fork não edita `CHANGELOG.md` (é o ficheiro com
   mais conflitos). As notas do fork ficam neste documento e nas PRs do fork.

## 5. Sincronização com o upstream

- `main` é o branch de integração do fork (fork e upstream juntos). Hoje
  `main == upstream/main`.
- Funcionalidades em `feat/<issue>-<slug>`, com PR para `C0reca/opencove:main`.
  O `gh repo set-default` já está configurado para o fork, para nenhuma PR ir
  para o upstream por engano.
- **Merge (não rebase)** do upstream, para não reescrever o histórico publicado
  nem as referências das PRs:
  `git fetch upstream && git checkout -b sync/upstream-YYYYMMDD main && git merge upstream/main`
  depois `pnpm verify:quick` mais os testes do plugin, e PR de sync.
- **Frequência:** semanal, ou a cada nightly que se queira usar. Também antes de
  começar F2.b, para reduzir a janela de conflito.
- Commits do núcleo com scope `core` (`feat(core): … (#6)`), para os encontrar
  depressa num conflito (`git log --grep '(core)'`).
- Ordem de implementação: #2 → #5 → #8 → #9 → #6 → #7 (feasibility).
