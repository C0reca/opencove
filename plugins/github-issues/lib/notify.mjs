// Phone notices (#59). One adapter per channel, all with send({ title, message, tags, url }).
// Text carries only owner/repo, the issue number and the event type: never titles, bodies or
// agent output, because the notice leaves the machine (ntfy.sh topics are public by default).
export const NOTIFY_CHANNEL_PREFERENCE = 'notify-channel'
export const NTFY_TOPIC_PREFERENCE = 'ntfy-topic'
export const NTFY_SERVER_PREFERENCE = 'ntfy-server'
export const NOTIFY_WAITING_PREFERENCE = 'notify-waiting-minutes'
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh'
export const DEFAULT_WAITING_MINUTES = 10
const SEND_TIMEOUT_MS = 5_000

const EVENTS = {
  review: { message: () => 'Pull request ready for review', tags: ['eyes'] },
  waiting: {
    message: ({ minutes }) => `Agent waiting for over ${minutes} min`,
    tags: ['hourglass'],
  },
  coordinator: { message: () => 'Coordinator stopped with issues in progress', tags: ['warning'] },
}

// ntfy JSON publishing: POST to the server root, so the topic never has to be URL-encoded.
function ntfyChannel({ server, topic, fetchImpl }) {
  return {
    async send({ title, message, tags, url }) {
      const response = await fetchImpl(new URL('/', server), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, title, message, tags, click: url }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`ntfy answered ${response.status}`)
      }
    },
  }
}

// Resolves the configured channel, or null when notices are off or incomplete.
function channelFrom(preferences, fetchImpl) {
  if (preferences[NOTIFY_CHANNEL_PREFERENCE] !== 'ntfy') {
    return null
  }
  const topic = String(preferences[NTFY_TOPIC_PREFERENCE] ?? '').trim()
  if (!topic) {
    return null
  }
  const server = String(preferences[NTFY_SERVER_PREFERENCE] ?? '').trim() || DEFAULT_NTFY_SERVER
  if (!/^https?:\/\//i.test(server)) {
    throw new Error(`ntfy-server must be an http(s) URL`)
  }
  return ntfyChannel({ server, topic, fetchImpl })
}

export function waitingMinutesOf(preferences) {
  const value = Number(preferences?.[NOTIFY_WAITING_PREFERENCE])
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WAITING_MINUTES
}

export function noticeFor({ event, repo, number, minutes }) {
  const spec = EVENTS[event]
  const hasNumber = Number.isInteger(number)
  return {
    title: hasNumber ? `${repo}#${number}` : repo,
    message: spec.message({ minutes }),
    tags: spec.tags,
    url: hasNumber ? `https://github.com/${repo}/issues/${number}` : `https://github.com/${repo}`,
  }
}

// notify() never throws: a failed notice must not fail the command or pass that caused it.
// Dedupe: a key is sent at most once (within `windowMs` when given, otherwise for good).
export function createNotifier({
  host,
  log = () => undefined,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  // ponytail: in-memory keys, reset on plugin restart; persist them if restarts cause repeats.
  const sentAt = new Map()

  async function notify({ key, event, repo, number, minutes, windowMs }) {
    try {
      const preferences = (await host.preferences.get()) ?? {}
      const channel = channelFrom(preferences, fetchImpl)
      if (!channel) {
        return false
      }
      const last = sentAt.get(key)
      if (last !== undefined && (windowMs === undefined || now() - last < windowMs)) {
        return false
      }
      sentAt.set(key, now())
      await channel.send(noticeFor({ event, repo, number, minutes }))
      return true
    } catch (caught) {
      log(
        `notify: ${event} notice failed: ${caught instanceof Error ? caught.message : String(caught)}`,
      )
      return false
    }
  }

  return { notify }
}
