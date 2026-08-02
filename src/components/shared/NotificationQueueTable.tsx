import { Badge } from '@/components/ui/badge'
import { formatDateTimeInTimeZone } from '@/lib/time'
import { KIND_LABELS, type NotificationQueueItem } from '@/types/notifications'

export interface QueueRow extends Pick<
  NotificationQueueItem,
  'id' | 'kind' | 'category' | 'channel' | 'status' | 'scheduled_for' | 'title' | 'skipped_reason'
> {
  recipient: string
}

/** Why something did not go, in the words the studio would use. */
const SKIP_REASONS: Record<string, string> = {
  marketing_opt_out: 'They have opted out of marketing',
  recipient_unavailable: 'Account suspended or gone',
  appointment_cancelled: 'The appointment was cancelled',
  appointment_started: 'The appointment had already begun',
  appointment_gone: 'The appointment no longer exists',
}

/**
 * The last few things the studio sent, or did not.
 *
 * The skipped rows are the point. "Why did she not get her reminder" is a
 * question that gets asked, and a queue that quietly dropped the row leaves
 * nobody able to answer it.
 */
export function NotificationQueueTable({
  rows,
  timeZone,
}: {
  rows: QueueRow[]
  timeZone: string
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        Nothing yet. Messages appear here as they go out.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left">
            <th className="label-caps py-3 pr-4 font-normal text-[var(--color-muted)]">When</th>
            <th className="label-caps py-3 pr-4 font-normal text-[var(--color-muted)]">Who</th>
            <th className="label-caps py-3 pr-4 font-normal text-[var(--color-muted)]">What</th>
            <th className="label-caps py-3 font-normal text-[var(--color-muted)]">Outcome</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="py-3 pr-4 align-top text-xs tabular-nums text-[var(--color-muted)]">
                {formatDateTimeInTimeZone(new Date(r.scheduled_for), timeZone)}
              </td>
              <td className="py-3 pr-4 align-top">{r.recipient}</td>
              <td className="py-3 pr-4 align-top">
                <p>{KIND_LABELS[r.kind]}</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">{r.title}</p>
              </td>
              <td className="py-3 align-top">
                {r.status === 'sent' && <Badge tone="success" size="sm">Sent</Badge>}
                {r.status === 'pending' && (
                  <Badge tone="neutral" size="sm">
                    {r.channel === 'in_app' ? 'Queued' : `Waiting on ${r.channel}`}
                  </Badge>
                )}
                {r.status === 'skipped' && (
                  <>
                    <Badge tone="warning" size="sm">Not sent</Badge>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      {SKIP_REASONS[r.skipped_reason ?? ''] ?? r.skipped_reason}
                    </p>
                  </>
                )}
                {r.status === 'failed' && <Badge tone="danger" size="sm">Failed</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
