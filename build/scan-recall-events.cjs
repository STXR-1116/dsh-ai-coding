/* Scan durable session logs for knowledge-search events and report the gate's
   outcome. The event is the only place the gate's decision is recorded, so this
   is how "did the gate actually judge?" is answered from evidence rather than by
   asking a log to be trusted. */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const root = path.join(process.env.USERPROFILE, '.dsh', 'sessions')
if (!fs.existsSync(root)) { console.log('no sessions dir'); process.exit(0) }

/** Every session file, newest first. */
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.startsWith('session')) out.push(full)
  }
  return out
}

const files = walk(root)
  .map(file => ({ file, mtime: fs.statSync(file).mtime }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 6)

for (const { file, mtime } of files) {
  let text
  try {
    const raw = fs.readFileSync(file)
    text = file.endsWith('.zstd') ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
  } catch (error) {
    console.log(`  ${path.basename(file)}  decompress failed: ${error.message}`)
    continue
  }
  const lines = text.split('\n')
  const recalls = []
  for (const line of lines) {
    if (!line.includes('knowledge-search')) continue
    try { recalls.push(JSON.parse(line)) } catch { /* a non-JSON line is not an event */ }
  }
  // Local time, not `toISOString()`: that prints UTC, which on a UTC+8 host names
  // the wrong session (19:52 local reads as 11:52) and makes the output unusable
  // for "which session is this".
  const stamp = `${String(mtime.getMonth() + 1).padStart(2, '0')}-${String(mtime.getDate()).padStart(2, '0')} ${String(mtime.getHours()).padStart(2, '0')}:${String(mtime.getMinutes()).padStart(2, '0')}`
  if (recalls.length === 0) { console.log(`  ${stamp}  ${path.basename(file)}  — 无召回事件`); continue }
  console.log(`  ${stamp}  ${path.basename(file)}  — ${recalls.length} 条召回事件`)
  for (const event of recalls.slice(-4)) {
    // Events are stored wrapped; find the payload wherever the shape nests it.
    const data = event.data ?? event.payload?.data ?? event
    const gate = data?.gate ?? '(无 gate 字段)'
    const routes = Array.isArray(data?.results) ? data.results.map(r => r.route ?? '?') : []
    const withAnswers = Array.isArray(data?.results) ? data.results.filter(r => r.answers !== undefined).length : 0
    console.log(`      gate=${JSON.stringify(gate)}  routes=[${routes.join(',')}]  answers条数=${withAnswers}`)
  }
}
