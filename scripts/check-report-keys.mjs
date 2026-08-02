#!/usr/bin/env node
/**
 * A report module declares its own `key`; the registry maps a key to a lazy
 * import; the URL segment is that same key. If the two disagree the report
 * still typechecks and still builds — it fails only when a person clicks it.
 *
 * That is exactly the kind of break worth a two-second check, so this runs in
 * `npm run check`.
 */
import { readFileSync, readdirSync } from 'node:fs'

const DIR = 'src/lib/reports'
const registry = readFileSync(`${DIR}/registry.ts`, 'utf8')

// key → module file, from `'key': { group: …, load: () => import('./file') }`
const entries = [...registry.matchAll(
  /^\s+'?([a-z0-9_-]+)'?:\s*\{\s*group:[^}]*?import\('\.\/([a-z0-9-]+)'\)/gm
)].map(([, key, file]) => ({ key, file }))

let failed = false
for (const { key, file } of entries) {
  let src
  try {
    src = readFileSync(`${DIR}/${file}.ts`, 'utf8')
  } catch {
    console.error(`  ✗ registry key '${key}' imports ./${file}, which does not exist`)
    failed = true
    continue
  }
  const declared = /^\s*key:\s*'([a-z0-9_-]+)'/m.exec(src)?.[1]
  if (declared !== key) {
    console.error(`  ✗ ${file}.ts declares key '${declared}' but the registry maps it as '${key}'`)
    failed = true
  }
}

// Every module that exports a ReportModule should be reachable.
const registered = new Set(entries.map((e) => e.file))
const SHARED = new Set(['types', 'registry', 'shell', 'money', 'csv', 'custom'])
for (const f of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
  const name = f.replace(/\.ts$/, '')
  if (SHARED.has(name) || registered.has(name)) continue
  if (/:\s*ReportModule\s*=/.test(readFileSync(`${DIR}/${f}`, 'utf8'))) {
    console.error(`  ✗ ${f} exports a report but is not in the registry — it is unreachable`)
    failed = true
  }
}

if (!failed) console.log(`  ✓ ${entries.length} reports: keys match and all are reachable`)
process.exit(failed ? 1 : 0)
