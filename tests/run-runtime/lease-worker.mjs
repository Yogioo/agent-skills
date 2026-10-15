/** Contention worker: acquire a lease, hold it briefly if won, print one JSON line. */
import { acquireLease } from '../../lib/run-runtime/lease.mjs'

const [registryDir, workdir] = process.argv.slice(2)
const result = acquireLease({ registryDir, workdir })
if (result.ok) {
  process.stdout.write(`${JSON.stringify({ ok: true, token: result.record.token, pid: result.record.pid })}\n`)
  setTimeout(() => process.exit(0), 900)
} else {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: result.reason })}\n`)
}
