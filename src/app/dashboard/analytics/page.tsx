import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * Analytics moved under Marketing.
 *
 * Kept as a stub because the range and segment filters live entirely in the
 * query string, so a bookmark or a pasted link is rarely bare `/analytics` —
 * it is `?days=90&segment=client`, and dropping that would silently reset
 * someone's view to the default 30 days for everyone. Everything is forwarded
 * verbatim; the destination re-validates it exactly as before.
 *
 * Temporary rather than permanent on purpose: a 308 gets cached by the browser
 * and would outlive any future change of mind about where this page lives.
 */
export default async function AnalyticsMovedPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) query.append(key, v)
    } else if (value !== undefined) {
      query.set(key, value)
    }
  }

  const qs = query.toString()
  redirect(`/dashboard/marketing/analytics${qs ? `?${qs}` : ''}`)
}
