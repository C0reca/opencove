# FORK_PLAN — C0reca/opencove

Fork de `DeadWaveWave/opencove` (remote `upstream`), base `v0.4.0-nightly.20261018.1`.
Objetivo: três funcionalidades de fluxo de trabalho com GitHub Issues, com a menor
divergência possível do núcleo para continuar a fazer merge do upstream.

Issues: plano #1 · F1 #2 · F2 #3 (#5, #6, #7, #11, #27) · F3 #4 (#8, #9, #37, #39, #40, #45, #46).
Estado (2026-10-22): implementado e validado ao vivo, incluindo o modo autónomo. O modelo de
operação atual está na §0 e prevalece sobre as regras originais da §2.0, que ficam como histórico.
Os ids de comandos e preferências usam hífen (o host recusa camelCase).
Para instalar: `pnpm build` e reiniciar a app; depois `opencove plugin install plugins/github-issues`.

## 0. Modelo de operação atual (2026-10-22)

**Agentes autónomos por repositório.**
- A preferência `permission-modes` (linhas `owner/repo: normal|auto|full`, com suporte a
  `owner/*`; a linha exata ganha à wildcard) define o modo dos agentes de issue **e** do
  coordenador, ao lançar e ao retomar.
- Correspondência com o núcleo (#39, `agentPermissionMode`), para o Claude Code:
  - normal → `--permission-mode default`
  - auto → `--permission-mode auto` (classificador)
  - full → `--dangerously-skip-permissions`
- O modo fica guardado no nó do agente e usa-se ao retomar (#27, #39).
- A antiga `auto-approve-repos` é lida como `full`.
- **Só em projetos locais (#46):** num projeto remoto, auto e full caem para normal e a sidebar
  mostra o aviso, porque o hook de guarda não corre no destino e falharia aberto.
- O "agent full access" global está desligado. Com o full access desligado o Claude recebe
  sempre `--permission-mode default` explícito, por isso nunca herda o auto mode do utilizador.

**Worktrees obrigatórias.**
- Cada agente de issue corre num Space filho `issue-<N>-<slug>`, com worktree e branch próprios.
- O coordenador corre num Space/worktree `issue-coordinator`.
- Não existe atribuição sem worktree. A raiz é o Space sem pai, excluindo as worktrees. Se
  houver mais do que uma raiz, a atribuição falha com erro explícito; `parentSpaceId` escolhe uma.

**Deny list obrigatória**, em `.claude/settings.local.json` de cada worktree (excluído do git
via `info/exclude`). Aplica-se em qualquer modo e está validada ao vivo em auto mode:
- `permissions.deny`:
  - `gh pr merge`, `gh pr close`, `gh issue close`, `gh api`
  - `git push --force`, `-f`, `--force-with-lease`
  - editar `.claude/`
- Hook `PreToolUse` de guarda (`plugins/github-issues/guard/agentGuard.mjs`, em exec-form pelo
  Electron em modo Node). Bloqueia as variantes e o que depende do caminho:
  - `+refspec`, push para `main`/`master`
  - `git -C`, `reset --hard` e `rm -r` fora da worktree
  - escritas em `.claude/`
  - comandos compostos
- `permissions.allow`, para correr sem pedir: consultas `gh pr|issue list|view -R …` e os
  comandos do plugin que o coordenador usa.

**Coordenador.**
- Lança-se com `coordinator.launch`. Segue a skill `issue-coordinator`:
  - processa das issues mais antigas para as mais recentes e ignora as que têm a label
    `no-agent`; o CLI recusa-as;
  - relê `agents.status` antes de cada `issue.assign`;
  - faz uma chamada por issue, com o número literal;
  - lê `issues.list` com `refresh: true` em cada volta.
- **Acordar (#45):** o backend do plugin vigia os agentes de issue e acorda o coordenador com
  mensagens `[github-issues] …` quando um agente passa a `done` ou `waiting`.
  - A mensagem é enviada em duas escritas (texto, depois Enter), por causa da proteção do Claude
    Code contra colagens.
  - Há debounce e nunca escreve com o coordenador a meio de um turno.
  - Preferência `coordinator-wake`.
- Num `waiting`, o coordenador lê o agente com `agents.read` e escreve ao humano o que ele pede.

**O merge é só do humano.**
- Com um PR pronto, o coordenador chama `issue.request-review`: label `needs-review` e
  comentário com resumo e evidência. A issue fica aberta.
- `issue.close` só fecha com PR `MERGED` que declare `Fixes #N`.
- O `main` do fork tem um ruleset ativo, sem exceções (id 25630824):
  - só aceita alterações por PR;
  - sem force push;
  - sem apagar o branch.

**Upstream.** Os PRs genéricos do núcleo ficam preparados em branches do fork e são abertos
pelo dono, porque implicam assinar o CLA. Abertos a 2026-10-23, à espera da aprovação dos
workflows (contribuidor novo) e possivelmente do check de CLA; sem comentários nem checks:
- DeadWaveWave/opencove#462 (`upstream/claude-permission-mode`): #11 + #27;
- DeadWaveWave/opencove#463 (`upstream/link-agent-to-task`): #6;
- o #39 vai depois de o #462 ser aceite.

**Limites conhecidos.**
- O guard reconhece um subconjunto de shell: não trata `eval`, heredocs nem variáveis em geral.
- As sugestões automáticas do Claude Code podem propor "merge the PR". O guard bloqueia-o.
- `worktree archive` não remove o Space, porque não existe `space.archive` na Control Surface.
  Os Spaces vazios arquivam-se na interface.

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
recebe duas alterações pequenas e genéricas (F2.b #6 e F2.d #11).

### 2.0 Regras de segurança (ajustes aprovados)

1. **Fecho de issues.** O coordenador só fecha issues com PR `MERGED`. Sem PR
   merged, aplica a label `needs-review` (o plugin cria-a se faltar) e comenta na
   issue o resumo e a evidência; o fecho fica para o humano. O fecho sem PR
   (`force`) **só existe como comando de menu** (`issue.close-manual`, que exige
   contexto de host) e é documentado como uso humano. Não aparece na CLI, na skill
   nem no `coordinator.launch`.
2. **Prompt injection.** O `issue.assign` só aceita issues cujo autor está na
   allowlist do repositório. Por omissão a allowlist tem o dono do repositório,
   `C0reca`, e os colaboradores com permissão `write`, `maintain` ou `admin`
   (`gh api repos/{o}/{r}/collaborators/{u}/permission`). Se essa consulta falhar,
   o autor é tratado como não autorizado.
   - Configuração: preferência `trusted-authors`, com linhas `owner/repo: alice, bob`
     ou `*: alice`. As preferências do plugin são escalares e globais, por isso a
     chave por projeto é o `owner/repo`. Os nomes acrescentam-se aos autores por
     omissão; não os substituem.
   - Issues fora da allowlist aparecem no painel marcadas como "autor não
     confiável". Só se atribuem pela ação manual de menu `issue.assign-untrusted`,
     que exige contexto de host e por isso não é chamável pelo `plugin run` da CLI.
   - Na tarefa, o conteúdo da issue fica dentro de um bloco
     `<github-issue-content trust="untrusted-user-data">…</github-issue-content>`,
     precedido de uma instrução explícita: são dados, não instruções. Qualquer
     ocorrência da tag de fecho dentro do corpo é neutralizada.
3. *(Substituída pela §0.)* **Permissões dos agentes.** Por omissão o Claude Code arranca em modo normal e
   pede permissões. A preferência `auto-approve-repos` (lista `owner/repo`, vazia por
   omissão) ativa a auto-aprovação por projeto. O painel mostra no topo da secção
   um item de aviso visível quando um projeto a tem ligada.
   - Isto exige a alteração de núcleo #11, porque hoje o plugin não consegue
     escolher o modo e a app usa por omissão `agentFullAccess: true`.
4. *(Substituída pela §0: o modo autónomo usa a deny list e o hook de guarda.)* **Limite conhecido.** As salvaguardas da CLI (sem `force`, allowlist) são
   barreiras de aplicação, não de segurança. Um agente com shell pode chamar `gh`
   diretamente, e quem tiver o token da Control Surface consegue forjar o contexto
   de menu. A barreira real é o coordenador correr em modo normal, em que o humano
   aprova cada comando de shell.

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
  1. `gh issue view N --json title,body,url,author`. Verifica a allowlist (§2.0.2).
  2. `host.nodes.create({kind:'task'})` com título `#N título`. O requirement
     leva o URL, o critério "abrir PR com `Fixes #N`" e o corpo da issue dentro do
     bloco não confiável (§2.0.2). As tags
     são `issue:owner/repo#N`, que é a ligação estável usada para reencontrar a
     tarefa (idempotente: se já existe uma tarefa com esta tag, reutiliza-a).
  3. `host.agents.launch({prompt: requirement, provider:'claude-code', agentFullAccess})`.
     `agentFullAccess` é `false`, a menos que o repositório esteja em `auto-approve-repos`.
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
- **F2.d (núcleo, isolado, #11):** campo opcional `agentFullAccess` no
  `node.create agent` e no `host.agents.launch`, passado ao `session.launchAgent`.
  Se for omitido, o comportamento é o atual. É genérico e candidato ao upstream.
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
  - `issue.close {number, pr, evidence}`: fecha só se o PR estiver `MERGED`.
    Comenta a evidência, faz `gh issue close` e passa a tarefa para `done`.
  - `issue.request-review {number, summary, evidence}`: aplica `needs-review` e
    comenta. É o caminho quando não há PR merged.
  - Só para humanos (menu, exige contexto de host): `issue.close-manual` e
    `issue.assign-untrusted`.
- **Skill** `issue-coordinator/SKILL.md` no plugin. Descreve o playbook: listar,
  priorizar, atribuir, monitorizar e fechar com prova, e quando parar e pedir input.
- Comando `coordinator.launch` (menu da sidebar/space): lança um agente com o
  prompt da skill. Arranca sempre em modo normal (`agentFullAccess: false`); a
  auto-aprovação aplica-se só aos agentes de issue.
- **Pré-requisito:** a CLI `opencove` no PATH dos terminais (Settings → Worker →
  CLI → Install CLI). Já está feito.
- **Porquê sem CLI nova:** `plugin run` já é a ponte CLI → backend do plugin,
  com JSON, timeout e erros estruturados.

## 3. Ficheiros a tocar

| Onde | Ficheiros | Conflito com upstream |
| --- | --- | --- |
| Plugin | `plugins/github-issues/**` (manifest, `main.mjs`, `lib/*.mjs`, skill, README) | nenhum (pasta nova) |
| Testes | `tests/unit/forkPlugins/githubIssues*.spec.ts` | nenhum (ficheiros novos) |
| Núcleo F2.b | `nodeDataFactory.ts`, `nodeCreateCommit.ts`, `nodeControlHandlers.ts`, `pluginCanvasHost.ts`, `commands/nodeControl.mjs`, `docs/cli/CANVAS_NODE_CONTROL.md`, `docs/plugins/CANVAS_API.md` | médio: zona ativa no upstream |
| Núcleo F2.d | `nodeControlHandlers.ts`/`nodeControlRuntime.ts`, `pluginCanvasHost.ts`, `commands/nodeControl.mjs`, os mesmos docs | médio: zona ativa no upstream |
| Núcleo #27 e #39 | `AgentCommandFactory.ts`, `hydrateAgentNode.ts`, `sessionPrepareOrRevivePreparation.ts`, `useAgentNodeLifecycle.support.ts`, a forma persistida do nó do agente, `src/shared/utils/agentPermissionMode.ts` | médio: lançamento e retoma de agentes |
| CLI F2.c | `src/app/cli/opencove.mjs` (ou `commands/space.mjs` novo), `usage.mjs` | baixo/médio: `opencove.mjs` é um if/else longo |
| Docs | `docs/FORK_PLAN.md` | nenhum |

## 4. Riscos

1. **`apiVersion: 1` do plugin pode mudar** de forma incompatível. Mitigação: um teste
   de fumo do plugin (manifesto válido mais comandos puros) corre em cada merge do
   upstream, e o plugin depende só dos métodos documentados em `HOST_API.md`.
2. **Conflitos de F2.b e F2.d** nos ficheiros de nodeControl. Mitigação: um commit
   isolado `feat(core): …` por alteração. A descrição do PR para o upstream fica
   preparada na issue; quem abre o PR é o dono do fork, porque implica assinar o CLA.
3. **`agentState` é observação, não verdade.** "done" não quer dizer que a tarefa
   está feita. Por isso o fecho exige PR merged, nunca só o estado.
4. **Plugin sem sandbox:** o backend corre `gh` com as credenciais da máquina. Só
   corre comandos `gh` fixos (sem shell, argumentos em array) e valida `number` como
   inteiro e `projectId` pela Host API.
5. **Rate limit e latência do `gh`** com muitos projetos. Cache curta (60 s) por
   repositório no backend, mais refresh manual.
6. **O guard falha aberto se o hook não correr** (por exemplo num mount remoto). Mitigação:
   auto e full só em projetos locais (#46), e as regras `permissions.deny` como segunda camada.
7. **CHANGELOG.md e `main`:** o fork não edita `CHANGELOG.md` (é o ficheiro com
   mais conflitos). As notas do fork ficam neste documento e nas PRs do fork.

## 5. Sincronização com o upstream

- `main` é o branch de integração do fork (fork e upstream juntos), protegido pelo ruleset
  da §0: até o sync do upstream entra por PR.
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
- Ordem de implementação: duas linhas em paralelo, com ficheiros disjuntos.
  - Plugin: #2 → #5 → #8 → #9.
  - Núcleo: #11 → #6 → #7 (feasibility).
  - O #5 só lança agentes depois de o #11 estar em `main`; o #6 liga depois a
    tarefa ao agente no `issue.assign`.
