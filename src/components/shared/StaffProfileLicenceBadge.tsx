import { Badge } from '@/components/ui/badge'
import { daysUntilDateKey, licenceStatus } from '@/types/team'

/**
 * How a licence stands, in one word.
 *
 * `now` is passed in rather than read here. In a Server Component a bare
 * Date.now() is an impure render (see requestNow in src/lib/time.ts); in a
 * Client Component it is also a hydration mismatch waiting for midnight. One
 * value, taken once, read by everything on the screen.
 */
export function StaffProfileLicenceBadge({
  expiresOn,
  now,
}: {
  expiresOn: string | null
  now: number
}) {
  const status = licenceStatus(expiresOn)
  const days = expiresOn ? daysUntilDateKey(expiresOn, now) : null

  if (status === 'unknown') {
    return <Badge tone="warning">No licence on file</Badge>
  }
  if (status === 'expired') {
    return (
      <Badge tone="danger">
        Expired{days != null && days < 0 ? ` ${Math.abs(days)}d ago` : ''}
      </Badge>
    )
  }
  if (status === 'expires_soon') {
    return <Badge tone="warning">Expires in {days}d</Badge>
  }
  return <Badge tone="success">Current</Badge>
}
