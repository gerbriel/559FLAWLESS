/**
 * Mobile audit. Screenshots key pages at phone width and reports the two
 * problems that actually break a phone layout:
 *
 *   1. horizontal overflow — any element wider than the viewport makes the
 *      whole page scroll sideways, which feels broken
 *   2. tap targets under 44x44 CSS px, the size below which they get hard to
 *      hit accurately
 *
 * Usage: node scripts/mobile-audit.mjs [baseUrl] [outDir]
 */

import { chromium, devices } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://localhost:3100'
const OUT = process.argv[3] ?? '/tmp/mobile'
mkdirSync(OUT, { recursive: true })

const PAGES = [
  ['home', '/'],
  ['services', '/services'],
  ['category', '/services/waxing'],
  ['service', '/services/waxing/full-brazilian'],
  ['book', '/book'],
  ['shop', '/shop'],
  ['contact', '/contact'],
  ['faq', '/faq'],
  ['login', '/login'],
]

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 13'] })
const page = await ctx.newPage()

let problems = 0

for (const [name, path] of PAGES) {
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 45000 })
  } catch {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 })
  }
  await page.waitForTimeout(700)

  const report = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth

    // Anything sticking out past the viewport.
    const overflow = []
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right > vw + 1 || r.left < -1) {
        const s = getComputedStyle(el)
        if (s.position === 'fixed' || s.overflowX === 'auto' || s.overflowX === 'scroll') continue
        overflow.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 60),
          right: Math.round(r.right),
          text: (el.textContent || '').trim().slice(0, 40),
        })
      }
    }

    // Interactive things that are too small to hit.
    const small = []
    for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.height < 44 || r.width < 44) {
        small.push({
          tag: el.tagName.toLowerCase(),
          w: Math.round(r.width),
          h: Math.round(r.height),
          text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 34),
        })
      }
    }

    return {
      vw,
      scrollW: document.documentElement.scrollWidth,
      overflow: overflow.slice(0, 6),
      overflowCount: overflow.length,
      small: small.slice(0, 8),
      smallCount: small.length,
    }
  })

  const sideways = report.scrollW > report.vw + 1
  if (sideways || report.smallCount) problems++

  console.log(`\n── ${name}  ${path}`)
  console.log(`   viewport ${report.vw}  scrollWidth ${report.scrollW}${sideways ? '   ⚠️  SCROLLS SIDEWAYS' : '  ok'}`)
  if (report.overflowCount) {
    console.log(`   ${report.overflowCount} element(s) past the edge:`)
    for (const o of report.overflow) console.log(`     <${o.tag}> right=${o.right} "${o.text}" .${o.cls}`)
  }
  if (report.smallCount) {
    console.log(`   ${report.smallCount} tap target(s) under 44px:`)
    for (const s of report.small) console.log(`     <${s.tag}> ${s.w}x${s.h} "${s.text}"`)
  }

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
}

await browser.close()
console.log(`\n${problems ? `${problems} page(s) with issues` : 'No layout issues found'} — screenshots in ${OUT}`)
