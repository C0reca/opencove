// Pure helpers for the gh CLI: argument lists, output parsing and failure classification.

export const ISSUE_LIMIT = 50
export const ISSUE_FIELDS = 'number,title,url,labels,assignees,author,updatedAt'
export const REPO_VIEW_ARGS = Object.freeze(['repo', 'view', '--json', 'nameWithOwner'])

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

// gh's stderr is merged into operation output, so skip any warning lines before the JSON.
export function extractJson(text) {
  const trimmed = String(text ?? '').trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split('\n')
    const start = lines.findIndex(line => /^\s*[[{]/.test(line))
    if (start < 0) {
      throw new Error('gh did not return JSON')
    }
    return JSON.parse(lines.slice(start).join('\n'))
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

export function parseRepoView(text) {
  const name = extractJson(text)?.nameWithOwner
  if (typeof name !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(name)) {
    throw new Error('gh repo view did not return nameWithOwner')
  }
  return name
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
  const outputText = String(output ?? '')
  const combined = `${outputText}\n${errorText}`

  if (/ENOENT|executable|not found|no such file/i.test(errorText)) {
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

  const detail = combined
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0)
  const reason =
    status === 'cancelled' ? 'gh was cancelled' : `gh failed (exit ${exitCode ?? 'unknown'})`
  return {
    code: 'gh-failed',
    message: (detail ? `${reason}: ${detail}` : reason).slice(0, 300),
  }
}
