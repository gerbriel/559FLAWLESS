import 'server-only'

/**
 * Who is asking, and may they.
 *
 * Every route under /api/data begins here. None of them takes the page's word
 * for anything: these URLs are guessable, they are reachable with curl, and the
 * dashboard hiding a link has never been a permission. AGENTS.md rule 4 —
 * "RLS is the security boundary, not the UI" — cuts both ways, and where a
 * route holds the service role it has to do the job RLS would have done.
 *
 * Not a route file. Next.js only treats `route.ts` as an endpoint, so this
 * sits beside them as an ordinary module.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isAdmin, isManager, type UserRole } from '@/types/database'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { CsvImportRole } from '@/lib/csv/schema'

export type Viewer = {
  id: string
  role: UserRole
  supabase: SupabaseClient<Database>
}

/**
 * A signed-in manager or above, or a response to return instead.
 *
 * MANAGER, for the whole page, and the reason is about volume rather than
 * secrecy. Front desk can already look up any client on screen — that is the
 * job. But "can look someone up" and "can walk out with the entire client list
 * in one file" are different powers, and the second is the one that ends up on
 * a personal laptop. Manager is where the studio already puts bulk client data:
 * analytics and marketing both sit there. So does everything this page writes —
 * services (022) and products (021) are both `is_manager()`.
 *
 * Importing CLIENTS is stricter again; see `requireImportRole`.
 */
export async function requireManager(): Promise<Viewer | NextResponse> {
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

  if (!profile || profile.suspended_at || !isManager(profile.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  return { id: user.id, role: profile.role, supabase }
}

/**
 * The extra check an import needs, on top of manager.
 *
 * Clients import at admin. `profiles` has one INSERT policy and it is
 * `id = auth.uid()`, so there is no row-level-security path by which one person
 * creates another's profile — the import has to use the service role, the same
 * way /api/admin/clients/create does. A route standing in for a policy must be
 * at least as strict as the policy it replaced, and changing somebody else's
 * profile is `is_admin()` in migration 001. So it is admin here.
 */
export function requireImportRole(viewer: Viewer, role: CsvImportRole): NextResponse | null {
  if (role === 'admin' && !isAdmin(viewer.role)) {
    return NextResponse.json(
      {
        error: 'forbidden',
        message:
          'Importing clients needs an admin. Creating an account for somebody else cannot go through row-level security, so this uses the service role — and it is held to the same bar the database sets for changing another person’s profile.',
      },
      { status: 403 }
    )
  }
  if (!isManager(viewer.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return null
}
