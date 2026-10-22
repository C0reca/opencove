// Pure helpers for the gh CLI: argument lists, output parsing and failure classification.

export const ISSUE_LIMIT = 50
export const ISSUE_FIELDS = 'number,title,url,labels,assignees,author,updatedAt'
export const GIT_REMOTE_ARGS = Object.freeze(['remote', '-v'])

// gh runs inside a host PTY, so it sees a terminal: it colours JSON, queries the terminal
// (OSC 11 / cursor position) and may page or prompt. These variables make it plain and
// non-interactive; they are passed through /usr/bin/env because operations take no env.
export const GH_ENV = Object.freeze([
  'NO_COLOR=1',
  'CLICOLOR=0',
  'TERM=dumb',
  'GH_PROMPT_DISABLED=1',
  'GH_NO_UPDATE_NOTIFIER=1',
  'GH_SPINNER_DISABLED=1',
  'GH_PAGER=cat',
  'PAGER=cat',
  'GIT_TERMINAL_PROMPT=0',
])

// Subcommands that accept --repo; gh api addresses the repository in its path instead.
const REPO_SCOPED = new Set(['issue', 'pr', 'label'])

// Appends an explicit --repo so gh never infers (or asks for) the base repository.
export function withRepo(args, repo) {
  return repo && REPO_SCOPED.has(args[0]) ? [...args, '--repo', repo] : [...args]
}

// Terminal control sequences a PTY adds around a command's output (same String.raw convention as
// ShellEnvironmentService's ANSI pattern): OSC queries, CSI colours/cursor, other ESC sequences,
// and stray control characters.
const OSC_PATTERN = new RegExp(String.raw`\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)`, 'g')
const CSI_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'g')
const ESC_PATTERN = new RegExp(String.raw`\u001B[@-_]`, 'g')
const CONTROL_PATTERN = new RegExp(String.raw`[\u0000-\u0008\u000B-\u001F\u007F]`, 'g')

// Strips those sequences and carriage returns so the remaining text can be parsed.
export function cleanTerminalOutput(text) {
  return String(text ?? '')
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(ESC_PATTERN, '')
    .replace(/\r/g, '')
    .replace(CONTROL_PATTERN, '')
}

// Removes anything that looks like a GitHub token before text reaches an error message.
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/((?:token|authorization|password)\s*[:=]\s*)[^\n]*/gi, '$1[redacted]')
}

// The first few non-empty output lines, cleaned and redacted, for error messages.
export function outputExcerpt(text, maxLines = 3) {
  return redactSecrets(cleanTerminalOutput(text))
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .slice(0, maxLines)
    .join(' | ')
    .slice(0, 400)
}

export function issueListArgs() {
  return [
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    String(ISSUE_LIMIT),
    '--json',
    ISSUE_FIELDS,
  ]
}

// gh's stderr is merged into the PTY output, so clean it and skip warning lines before the JSON.
export function extractJson(text) {
  const cleaned = cleanTerminalOutput(text).trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const lines = cleaned.split('\n')
    const start = lines.findIndex(line => /^\s*[[{]/.test(line))
    try {
      if (start >= 0) {
        return JSON.parse(lines.slice(start).join('\n'))
      }
    } catch {
      // Fall through to the descriptive error below.
    }
    const excerpt = outputExcerpt(text)
    throw new Error(`gh did not return JSON${excerpt ? `: ${excerpt}` : ' (empty output)'}`)
  }
}

export function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.number)) {
    return null
  }
  return {
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    labels: (Array.isArray(raw.labels) ? raw.labels : [])
      .map(label => label?.name)
      .filter(name => typeof name === 'string' && name.length > 0),
    assignees: (Array.isArray(raw.assignees) ? raw.assignees : [])
      .map(user => user?.login)
      .filter(login => typeof login === 'string' && login.length > 0),
    author: typeof raw.author?.login === 'string' ? raw.author.login : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
}

export function parseIssueList(text) {
  const data = extractJson(text)
  if (!Array.isArray(data)) {
    throw new Error('gh issue list did not return an array')
  }
  return data.map(normalizeIssue).filter(issue => issue !== null)
}

// owner/repo of a github.com remote URL (ssh, scp-like or https), or null.
export function githubRepoFromUrl(url) {
  const match =
    /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(
      String(url ?? '').trim(),
    )
  return match ? `${match[1]}/${match[2]}` : null
}

// Picks the GitHub repository from `git remote -v`, preferring origin, then the first remote
// that points at github.com. Returns null when no remote is a GitHub repository.
export function parseGitRemotes(text) {
  const remotes = cleanTerminalOutput(text)
    .split('\n')
    .map(line => /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line.trim()))
    .filter(Boolean)
    .map(([, name, url]) => ({ name, repo: githubRepoFromUrl(url) }))
    .filter(remote => remote.repo)
  return (remotes.find(remote => remote.name === 'origin') ?? remotes[0])?.repo ?? null
}

export function issueViewArgs(number) {
  return ['issue', 'view', String(number), '--json', 'number,title,body,url,author,labels']
}

// The author is the trust subject; a missing author stays null and is treated as untrusted.
export function parseIssueView(text) {
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.number)) {
    throw new Error('gh issue view did not return an issue')
  }
  return {
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    author: typeof raw.author?.login === 'string' ? raw.author.login : null,
    labels: (Array.isArray(raw.labels) ? raw.labels : [])
      .map(label => label?.name)
      .filter(name => typeof name === 'string'),
  }
}

// The caller validates `repo` and `login` against GitHub's character sets before calling.
export function collaboratorPermissionArgs(repo, login) {
  return ['api', `repos/${repo}/collaborators/${login}/permission`]
}

export function parseCollaboratorPermission(text) {
  const permission = extractJson(text)?.permission
  if (typeof permission !== 'string') {
    throw new Error('gh api did not return a permission')
  }
  return permission
}

export const NEEDS_REVIEW_LABEL = 'needs-review'
// Issues with this label stay visible but the coordinator never assigns them (#37).
export const NO_AGENT_LABEL = 'no-agent'

export function prViewArgs(pr) {
  return ['pr', 'view', String(pr), '--json', 'state,closingIssuesReferences,url']
}

// `closes` lists the issue numbers the PR declares it closes (Fixes #N / Closes #N).
export function parsePrView(text) {
  const raw = extractJson(text)
  if (!raw || typeof raw !== 'object') {
    throw new Error('gh pr view did not return a pull request')
  }
  const references = Array.isArray(raw.closingIssuesReferences) ? raw.closingIssuesReferences : []
  return {
    state: typeof raw.state === 'string' ? raw.state.toUpperCase() : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    closes: references.map(reference => reference?.number).filter(Number.isInteger),
  }
}

export function issueCloseArgs(number) {
  return ['issue', 'close', String(number)]
}

// The body is one argv element, never a shell string.
export function issueCommentArgs(number, body) {
  return ['issue', 'comment', String(number), '--body', body]
}

export function issueAddLabelArgs(number, label) {
  return ['issue', 'edit', String(number), '--add-label', label]
}

// --force makes creation idempotent: an existing label is updated instead of failing.
export function labelCreateArgs(label, description) {
  return ['label', 'create', label, '--color', 'FBCA04', '--description', description, '--force']
}

const MESSAGES = {
  'gh-missing':
    'GitHub CLI (gh) is not installed on this machine. Install it from https://cli.github.com/.',
  'gh-unauthenticated': 'GitHub CLI is not logged in. Run `gh auth login` on this machine.',
  'not-github': 'This project is not a GitHub repository (no GitHub remote found).',
}

// Maps a finished or failed gh operation to { code, message }. Never throws.
export function classifyGhFailure({
  status = 'failed',
  exitCode = null,
  output = '',
  error = '',
} = {}) {
  const errorText = String(error ?? '')
  const outputText = cleanTerminalOutput(output)
  const combined = `${outputText}\n${errorText}`

  // 127 is env's "command not found" exit status.
  if (exitCode === 127 || /ENOENT|executable|not found|no such file/i.test(errorText)) {
    return { code: 'gh-missing', message: MESSAGES['gh-missing'] }
  }
  if (/gh auth login|not logged in|authentication required|GH_TOKEN|HTTP 401/i.test(combined)) {
    return { code: 'gh-unauthenticated', message: MESSAGES['gh-unauthenticated'] }
  }
  if (
    /not a git repository|no git remotes?|could not determine current repository/i.test(combined)
  ) {
    return { code: 'not-github', message: MESSAGES['not-github'] }
  }

  const detail = outputExcerpt(combined)
  const reason =
    status === 'cancelled' ? 'gh was cancelled' : `gh failed (exit ${exitCode ?? 'unknown'})`
  return { code: 'gh-failed', message: `${reason}: ${detail || '(no output)'}`.slice(0, 500) }
}
