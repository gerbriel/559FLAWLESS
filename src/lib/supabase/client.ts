import { createBrowserClient } from '@supabase/ssr'
import type { Database } from '@/types/database'

/** Browser-side client. Anon key only — every table is protected by RLS. */
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
