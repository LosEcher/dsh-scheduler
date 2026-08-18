#!/usr/bin/env node
// Fake dsh CLI for dsh-scheduler execution-path tests.
//
// The scheduler spawns `node <cli> --profile headless "<prompt>"`. This stub
// lets tests exercise runJob/finish end-to-end without booting a real agent:
//   - default          → exit 0 (succeeded)
//   - prompt has __FAIL__ → stderr + exit 3 (failed)
//   - prompt has __HANG__ → sleep FAKE_HANG_MS (default 3000) then exit 0
const prompt = process.argv[process.argv.length - 1] ?? ''
if (prompt.includes('__HANG__')) {
  const ms = Number(process.env.FAKE_HANG_MS ?? 3000)
  setTimeout(() => process.exit(0), ms)
} else if (prompt.includes('__FAIL__')) {
  process.stderr.write('fake failure for test\n')
  process.exit(3)
} else {
  process.exit(0)
}
