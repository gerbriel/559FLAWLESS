import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * "My hours" moved to /dashboard/calendar/hours.
 *
 * The Google OAuth routes were repointed in the same change, so nothing in this
 * codebase still sends anyone here. This exists for the links we do not control:
 * a bookmark, or a consent screen someone left open across the deploy that comes
 * back to `?calendar=connected`. The whole query string is carried over — losing
 * `calendar` would mean granting access and being shown no confirmation at all.
 */
export default async function ScheduleMoved({ searchParams }: Props) {
  const params = await searchParams

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const v of value) query.append(key, v)
    else if (value !== undefined) query.append(key, value)
  }

  const qs = query.toString()
  redirect(qs ? `/dashboard/calendar/hours?${qs}` : '/dashboard/calendar/hours')
}
