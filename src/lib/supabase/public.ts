import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

/**
 * Cookie-free client for public, cacheable data.
 *
 * `createServerClient` from @supabase/ssr reads cookies to attach the session.
 * Touching cookies opts a route into dynamic rendering, so a page that only
 * wants the service menu still ends up server-rendered on every request — the
 * whole marketing site pays a round-trip for a session it never uses.
 *
 * This client sends the anon key and nothing else, so RLS evaluates as the
 * `anon` role. That is exactly the audience these pages are written for: every
 * table they read (services, categories, site_content, business_hours, faqs,
 * retail products, approved testimonials) has a `to anon` select policy.
 *
 * Use it for anything a signed-out visitor could see. Use `server.ts` the
 * moment a page needs to know who is looking.
 */
export function createPublicClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}
