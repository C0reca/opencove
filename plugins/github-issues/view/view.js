// Review queue view (#56). PR titles, summaries and evidence are untrusted text: textContent only.
const api = window.opencovePlugin
const queue = document.querySelector('#queue')
const status = document.querySelector('#status')
const refresh = document.querySelector('#refresh')
const template = document.querySelector('#item')
const CI_LABEL = {
  passing: 'CI passing',
  failing: 'CI failing',
  pending: 'CI pending',
  none: 'No CI',
}

const messageOf = caught => (caught instanceof Error ? caught.message : String(caught))
const safeUrl = url => (/^https:\/\/github\.com\//.test(url) ? url : '')

function age(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  return Number.isFinite(days) ? (days < 1 ? 'opened today' : `opened ${days} d ago`) : ''
}

function setLink(element, text, url) {
  element.textContent = text
  const href = safeUrl(url)
  if (href) {
    element.href = href
  } else {
    element.removeAttribute('href')
  }
}

function render(item) {
  const node = template.content.firstElementChild.cloneNode(true)
  const find = selector => node.querySelector(selector)
  find('.repo').textContent = item.repo
  setLink(find('.issue'), `#${item.issue.number} ${item.issue.title}`, item.issue.url)
  setLink(find('.pr'), `PR #${item.pr.number} ${item.pr.title}`, item.pr.url)
  find('.ci').textContent = CI_LABEL[item.pr.ci] ?? item.pr.ci
  find('.ci').dataset.ci = item.pr.ci
  find('.age').textContent = item.pr.createdAt ? age(item.pr.createdAt) : ''
  setLink(find('.diff'), 'Diff', item.pr.url ? `${item.pr.url}/files` : '')
  find('.summary').textContent = item.summary ? `Summary: ${item.summary}` : 'No agent summary.'
  find('.evidence').textContent = item.evidence ? `Evidence: ${item.evidence}` : 'No test evidence.'
  find('.files summary').textContent = `${item.pr.files.length} changed files`
  for (const path of item.pr.files) {
    const entry = document.createElement('li')
    entry.textContent = path
    find('.files ul').append(entry)
  }

  const buttons = [...node.querySelectorAll('.actions button')]
  const comment = find('textarea')
  const error = find('.error')
  const target = { projectId: item.projectId, number: item.issue.number, pr: item.pr.number }
  // Every decision disables all buttons until it settles, so a double click cannot repeat it.
  async function decide(method, extra) {
    buttons.forEach(button => (button.disabled = true))
    error.textContent = ''
    try {
      await api.invoke(method, { ...target, ...extra })
      await load(true)
    } catch (caught) {
      error.textContent = messageOf(caught)
      buttons.forEach(button => (button.disabled = false))
    }
  }
  function withComment(method) {
    const body = comment.value.trim()
    if (!body) {
      error.textContent = 'Write a comment first.'
      comment.focus()
      return
    }
    decide(method, { body })
  }
  find('.merge').addEventListener('click', () => decide('review.merge', {}))
  find('.changes').addEventListener('click', () => withComment('review.request-changes'))
  find('.close').addEventListener('click', () => withComment('review.close'))
  return node
}

async function load(force = false) {
  refresh.disabled = true
  status.textContent = 'Reading pull requests…'
  try {
    const { items, errors, preview } = await api.invoke('review.list', { refresh: force })
    queue.replaceChildren(...items.map(render))
    const problems = errors.map(item => `${item.repo ?? item.projectId ?? ''}: ${item.message}`)
    status.textContent = [
      preview ? 'Preview: GitHub is not read.' : `${items.length} pull requests to review.`,
      ...problems,
    ].join(' ')
  } catch (caught) {
    status.textContent = messageOf(caught)
  } finally {
    refresh.disabled = false
  }
}

async function initialize() {
  if (!api) {
    status.textContent = 'Open this view through OpenCove.'
    return
  }
  await api.ready
  refresh.addEventListener('click', () => load(true))
  await load(false)
}

initialize()
