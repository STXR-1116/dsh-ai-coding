/* One real, minimal TypeSafe call.
 *
 * Purpose: settle two facts that no amount of reading can settle — whether the
 * key in `~/.dsh/.env` is usable, and whether `api.typesafe.ai` is reachable from
 * this host. This machine has already shown partial network blocking (the npm
 * registry is dead while GitHub is fine), so reachability has to be measured.
 *
 * One HTTP request, one Noul question. The state is a query/passage pair whose
 * answer should be a clear yes, so a plausible high value also sanity-checks that
 * the request shape is right rather than merely that something answered. The
 * input is Chinese on purpose: the official models page lists CJK as handled but
 * "not equally well" and asks to test on your own content.
 *
 * The key is read from the file (its `user-env` source) and never printed — only
 * its length, so a failure can be told apart from "wrong key".
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const envFile = join(homedir(), '.dsh', '.env')
const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find(l => l.startsWith('TYPESAFE_API_KEY='))
const apiKey = line?.slice('TYPESAFE_API_KEY='.length).trim()
console.log(`key: ${apiKey ? `${apiKey.length} chars from ${envFile}` : 'NOT FOUND'}`)
if (!apiKey) process.exit(1)

const body = {
  model: 'jev-1.13.0',
  state: {
    query: '发布评审需要哪些人签字？',
    passage: {
      title: '发布评审要求',
      text: '发布前必须至少有一名非作者完成评审，并在发布单上签字确认。',
    },
  },
  questions: {
    is_relevant: {
      type: 'noul',
      instructions: 'Does `passage` address the subject of `query`?',
    },
  },
}

const started = Date.now()
let response
try {
  response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
} catch (error) {
  console.log(`request failed after ${Date.now() - started}ms: ${error.name}: ${error.message}`)
  process.exit(1)
}

const text = await response.text()
console.log(`http ${response.status} in ${Date.now() - started}ms`)
if (!response.ok) {
  console.log(`body: ${text.slice(0, 400)}`)
  process.exit(1)
}

const parsed = JSON.parse(text)
console.log(`model: ${parsed.model}`)
console.log(`answers: ${JSON.stringify(parsed.answers)}`)
console.log(`usage: ${JSON.stringify(parsed.usage)}`)
console.log(`is_relevant = ${parsed.answers?.is_relevant?.noul}   (relevant pair; a high value is the expected answer)`)
