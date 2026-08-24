import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Drop the cached copies of pages whose content just changed.
 *
 * The storefront is deliberately static — the public layout refuses to read a
 * session so every marketing page can be cached and revalidated on a timer
 * (five minutes for most, two for the shop). That is the right trade for
 * visitors and the wrong one for the person who just retyped a service name
 * and wants to see it, so this is the seam that skips the wait.
 *
 * `'layout'` rather than `'page'`, because a service's name appears on the
 * menu AND on its own page AND in the header's dropdown, and those are three
 * separately cached routes. Revalidating `/services` as a layout takes the
 * whole subtree with it, which is the honest scope: the edit really did change
 * all of them.
 *
 * MANAGER, not admin. The kit that calls this is admin-only today, but the
 * writes it makes are governed by each table's own policy — services and
 * products are `is_manager()` (022, 021) — and a cache-busting endpoint should
 * not be the thing that decides who may edit. It refuses anonymous callers and
 * otherwise does something harmless: at worst a page is rebuilt early.
 */

/** Only routes this app actually serves; never a path from the caller verbatim. */
const ALLOWED = new Set(['/', '/services', '/shop', '/about', '/policies', '/faq', '/team'])

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isManager(profile.role as UserRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as { paths?: unknown } | null
  const asked = Array.isArray(body?.paths) ? body.paths : []

  const done: string[] = []
  for (const path of asked) {
    if (typeof path !== 'string' || !ALLOWED.has(path)) continue
    revalidatePath(path, 'layout')
    done.push(path)
  }

  return NextResponse.json({ ok: true, revalidated: done })
}
