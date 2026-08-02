#!/usr/bin/env node
/**
 * Structural guard for src/types/database.ts.
 *
 * Two failure modes cost real time this session, and neither shows up as an
 * error IN this file — both silently collapse every query result to `never`
 * across the whole app, hundreds of files away:
 *
 *   1. A duplicate key in Tables / Functions / Enums.
 *   2. A TableDef sitting inside the Functions map (or an Args/Returns entry
 *      inside Tables), which happens when a merge anchor appears in both
 *      sections and a global find-and-replace hits both.
 *
 * Both are trivial to detect here and nearly impossible to spot downstream, so
 * this runs in `npm run check` before anything else.
 */
import { readFileSync } from 'node:fs'

const lines = readFileSync('src/types/database.ts', 'utf8').split('\n')
const SECTIONS = ['Tables', 'Views', 'Functions', 'Enums', 'CompositeTypes']

const starts = SECTIONS.map((name) => ({
  name,
  at: lines.findIndex((l) => new RegExp(`^    ${name}: \\{`).test(l)),
})).filter((s) => s.at !== -1).sort((a, b) => a.at - b.at)

let failed = false
const fail = (msg) => { failed = true; console.error(`  ✗ ${msg}`) }

starts.forEach((section, i) => {
  const end = i + 1 < starts.length ? starts[i + 1].at : lines.length
  const seen = new Map()

  for (let j = section.at + 1; j < end; j++) {
    const m = /^      ([a-z_][a-z0-9_]*)\s*:(.*)$/.exec(lines[j])
    if (!m) continue
    const [, key, rest] = m

    if (seen.has(key)) {
      fail(`${section.name}.${key} declared twice (lines ${seen.get(key)} and ${j + 1})`)
    }
    seen.set(key, j + 1)

    // A TableDef belongs in Tables; anything with Args belongs in Functions.
    if (section.name === 'Functions' && /TableDef</.test(rest)) {
      fail(`${section.name}.${key} is a TableDef — it belongs in Tables (line ${j + 1})`)
    }
    if (section.name === 'Tables' && /^\s*\{\s*Args:/.test(rest)) {
      fail(`${section.name}.${key} looks like a function — it belongs in Functions (line ${j + 1})`)
    }
  }

  if (!failed) console.log(`  ✓ ${section.name}: ${seen.size} keys`)
})

// Every table a Relationship points at must actually be declared.
const src = lines.join('\n')
const tablesStart = starts.find((s) => s.name === 'Tables')
const tablesEnd = starts[starts.indexOf(tablesStart) + 1]?.at ?? lines.length
const declared = new Set()
for (let j = tablesStart.at + 1; j < tablesEnd; j++) {
  const m = /^      ([a-z_][a-z0-9_]*)\s*:/.exec(lines[j])
  if (m) declared.add(m[1])
}
for (const target of new Set([...src.matchAll(/Rel<'[^']+',\s*\[[^\]]*\],\s*'([a-z_]+)'/g)].map((m) => m[1]))) {
  if (!declared.has(target)) fail(`a Relationship points at '${target}', which is not in Tables`)
}

process.exit(failed ? 1 : 0)
