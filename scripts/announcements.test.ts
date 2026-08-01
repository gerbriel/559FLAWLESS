/**
 * Announcement targeting tests. Run with `npm test`.
 *
 * Targeting decides what a real visitor is shown. Getting it wrong is either
 * invisible (a promo nobody sees) or embarrassing (a staff-only note shown to
 * clients), so the rules are pinned down here.
 */

import assert from 'node:assert/strict'
import {
  matchesPage,
  matchesAudience,
  isLive,
  selectAnnouncements,
  pickPerStyle,
  ANONYMOUS,
  type LiveAnnouncement,
  type Viewer,
} from '../src/lib/announcements'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${(err as Error).message.split('\n')[0]}`)
  }
}

const CLIENT: Viewer = { userId: 'client-1', role: 'client' }
const PROVIDER: Viewer = { userId: 'staff-1', role: 'provider' }
const ADMIN: Viewer = { userId: 'admin-1', role: 'admin' }

let nextId = 1
function ann(over: Partial<LiveAnnouncement> = {}): LiveAnnouncement {
  return {
    id: nextId++,
    title: 'Test',
    body: null,
    link_url: null,
    link_label: null,
    variant: 'promo',
    starts_at: null,
    ends_at: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    target_audience: { type: 'all' },
    target_pages: [],
    priority: 0,
    ...over,
  } as LiveAnnouncement
}

// ── Page matching ───────────────────────────────────────────
console.log('\nPage targeting')

test('no pages set means every page', () => {
  assert.equal(matchesPage([], '/anything'), true)
  assert.equal(matchesPage(null, '/anything'), true)
})

test('exact path matches only itself', () => {
  assert.equal(matchesPage(['/book'], '/book'), true)
  assert.equal(matchesPage(['/book'], '/shop'), false)
  assert.equal(matchesPage(['/book'], '/book/extra'), false)
})

test('a trailing slash does not change an exact match', () => {
  assert.equal(matchesPage(['/book/'], '/book'), true)
  assert.equal(matchesPage(['/book'], '/book/'), true)
})

test('wildcard covers the prefix and everything under it', () => {
  assert.equal(matchesPage(['/account/*'], '/account'), true)
  assert.equal(matchesPage(['/account/*'], '/account/orders'), true)
  assert.equal(matchesPage(['/account/*'], '/accounting'), false, 'must not match a mere string prefix')
  assert.equal(matchesPage(['/account/*'], '/shop'), false)
})

test('/* matches everything', () => {
  assert.equal(matchesPage(['/*'], '/literally/anything'), true)
})

test('several patterns are an OR', () => {
  assert.equal(matchesPage(['/book', '/shop/*'], '/shop/serum'), true)
  assert.equal(matchesPage(['/book', '/shop/*'], '/faq'), false)
})

test('the home page is targetable', () => {
  assert.equal(matchesPage(['/'], '/'), true)
  assert.equal(matchesPage(['/'], '/book'), false)
})

// ── Audience matching ───────────────────────────────────────
console.log('\nAudience targeting')

test('all includes everyone', () => {
  for (const v of [ANONYMOUS, CLIENT, PROVIDER, ADMIN]) {
    assert.equal(matchesAudience({ type: 'all' }, v), true)
  }
})

test('anonymous excludes anyone signed in', () => {
  assert.equal(matchesAudience({ type: 'anonymous' }, ANONYMOUS), true)
  assert.equal(matchesAudience({ type: 'anonymous' }, CLIENT), false)
  assert.equal(matchesAudience({ type: 'anonymous' }, ADMIN), false)
})

test('authenticated excludes signed-out visitors', () => {
  assert.equal(matchesAudience({ type: 'authenticated' }, ANONYMOUS), false)
  assert.equal(matchesAudience({ type: 'authenticated' }, CLIENT), true)
})

test('role targeting picks exactly those roles', () => {
  const staffOnly = { type: 'role' as const, roles: ['provider', 'admin'] as const }
  assert.equal(matchesAudience({ ...staffOnly, roles: ['provider', 'admin'] }, PROVIDER), true)
  assert.equal(matchesAudience({ ...staffOnly, roles: ['provider', 'admin'] }, ADMIN), true)
  assert.equal(matchesAudience({ ...staffOnly, roles: ['provider', 'admin'] }, CLIENT), false)
  assert.equal(matchesAudience({ ...staffOnly, roles: ['provider', 'admin'] }, ANONYMOUS), false)
})

test('a staff-only note never reaches a client or a stranger', () => {
  const a = { type: 'role' as const, roles: ['front_desk', 'manager', 'admin'] as const }
  assert.equal(matchesAudience({ ...a, roles: [...a.roles] }, CLIENT), false)
  assert.equal(matchesAudience({ ...a, roles: [...a.roles] }, ANONYMOUS), false)
})

test('specific clients match only those ids', () => {
  const a = { type: 'clients' as const, client_ids: ['client-1'] }
  assert.equal(matchesAudience(a, CLIENT), true)
  assert.equal(matchesAudience(a, { userId: 'client-2', role: 'client' }), false)
  assert.equal(matchesAudience(a, ANONYMOUS), false)
})

test('a missing audience is treated as everyone', () => {
  assert.equal(matchesAudience(null, ANONYMOUS), true)
  assert.equal(matchesAudience(undefined, CLIENT), true)
})

// ── Scheduling ──────────────────────────────────────────────
console.log('\nScheduling')

const NOW = new Date('2026-06-15T12:00:00Z')

test('inactive never shows', () => {
  assert.equal(isLive(ann({ is_active: false }), NOW), false)
})

test('not yet started does not show', () => {
  assert.equal(isLive(ann({ starts_at: '2026-07-01T00:00:00Z' }), NOW), false)
})

test('already ended does not show', () => {
  assert.equal(isLive(ann({ ends_at: '2026-06-01T00:00:00Z' }), NOW), false)
})

test('inside the window shows', () => {
  assert.equal(
    isLive(ann({ starts_at: '2026-06-01T00:00:00Z', ends_at: '2026-07-01T00:00:00Z' }), NOW),
    true
  )
})

// ── Selection ───────────────────────────────────────────────
console.log('\nSelection')

test('combines page, audience and schedule', () => {
  const list = [
    ann({ title: 'right', target_pages: ['/book'], target_audience: { type: 'anonymous' } }),
    ann({ title: 'wrong page', target_pages: ['/shop'], target_audience: { type: 'anonymous' } }),
    ann({ title: 'wrong audience', target_pages: ['/book'], target_audience: { type: 'authenticated' } }),
    ann({ title: 'expired', target_pages: ['/book'], ends_at: '2020-01-01T00:00:00Z' }),
  ]
  const got = selectAnnouncements(list, { pathname: '/book', viewer: ANONYMOUS, now: NOW })
  assert.deepEqual(got.map((a) => a.title), ['right'])
})

test('higher priority sorts first', () => {
  const list = [ann({ title: 'low', priority: 1 }), ann({ title: 'high', priority: 9 })]
  const got = selectAnnouncements(list, { pathname: '/', viewer: ANONYMOUS, now: NOW })
  assert.deepEqual(got.map((a) => a.title), ['high', 'low'])
})

test('equal priority falls back to newest', () => {
  const list = [
    ann({ title: 'older', priority: 5, created_at: '2026-01-01T00:00:00Z' }),
    ann({ title: 'newer', priority: 5, created_at: '2026-05-01T00:00:00Z' }),
  ]
  const got = selectAnnouncements(list, { pathname: '/', viewer: ANONYMOUS, now: NOW })
  assert.deepEqual(got.map((a) => a.title), ['newer', 'older'])
})

test('dismissed ids are excluded', () => {
  const a = ann({ title: 'gone' })
  const got = selectAnnouncements([a], {
    pathname: '/', viewer: ANONYMOUS, now: NOW, dismissed: [a.id],
  })
  assert.equal(got.length, 0)
})

test('one of each style, highest priority wins', () => {
  const list = [
    ann({ title: 'banner-low', display_style: 'banner', priority: 1 }),
    ann({ title: 'banner-high', display_style: 'banner', priority: 8 }),
    ann({ title: 'the-modal', display_style: 'modal', priority: 2 }),
  ]
  const picked = pickPerStyle(selectAnnouncements(list, { pathname: '/', viewer: ANONYMOUS, now: NOW }))
  assert.equal(picked.banner?.title, 'banner-high')
  assert.equal(picked.modal?.title, 'the-modal')
  assert.equal(picked.corner, undefined)
})

test('a row with no style set is treated as a banner', () => {
  const picked = pickPerStyle([ann({ title: 'legacy' })])
  assert.equal(picked.banner?.title, 'legacy')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
