# Phone notices

With `notify-channel: ntfy` and a topic, the backend publishes a notice to ntfy
(`lib/notify.mjs`, one adapter per channel with `send({ title, message, tags, url })`):

| Event | When | Dedupe |
| --- | --- | --- |
| Review | `issue.request-review` succeeds. | Same issue within 10 minutes. |
| Waiting | An issue agent has shown `waiting` longer than `notify-waiting-minutes`. | Once per waiting observation. |
| Coordinator stopped | A coordinator seen running is gone while an issue task is still in `doing`. | Once per stop. |

**Rules:**

- **No sensitive text:** a notice carries only `owner/repo`, the issue number and the event type,
  with a link to the issue. Never titles, bodies or agent output. Topics on ntfy.sh are public, so
  use a long, unguessable topic or your own server.
- **Never fails the cause:** a failed or refused send is logged and ignored; the command or wake pass
  that caused it goes on. Notices are not retried.
- **Off by default:** without `notify-channel: ntfy` and a topic, nothing is sent.
- The waiting and coordinator checks run in the wake timer, so they need a running coordinator and
  `coordinator-wake` on. Dedupe keys are kept in memory: a plugin reload can repeat a waiting notice.
