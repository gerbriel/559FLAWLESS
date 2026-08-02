import Link from 'next/link'
import {
  Calendar,
  Camera,
  ClipboardList,
  CreditCard,
  FileSignature,
  FlaskConical,
  NotebookPen,
  ShieldCheck,
  ShieldOff,
  ShoppingBag,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import type { ClientTimelineEntry, TimelineKind } from '@/types/clientprofile'

const ICON: Record<TimelineKind, typeof Calendar> = {
  appointment: Calendar,
  purchase: ShoppingBag,
  payment: CreditCard,
  note: NotebookPen,
  consent: FileSignature,
  intake: ClipboardList,
  photo: Camera,
  patch_test: FlaskConical,
  ban: ShieldOff,
  ban_lifted: ShieldCheck,
}

const KIND_LABEL: Record<TimelineKind, string> = {
  appointment: 'Visit',
  purchase: 'Bought',
  payment: 'Paid',
  note: 'Note',
  consent: 'Signed',
  intake: 'Intake',
  photo: 'Photo',
  patch_test: 'Patch test',
  ban: 'Bookings stopped',
  ban_lifted: 'Bookings reopened',
}

/** Which statuses are worth colouring, and how. */
function tone(entry: ClientTimelineEntry): 'success' | 'warning' | 'danger' | 'neutral' | 'accent' {
  if (entry.kind === 'ban') return 'danger'
  if (entry.kind === 'ban_lifted') return 'success'
  switch (entry.status) {
    case 'completed':
    case 'succeeded':
    case 'pass':
    case 'valid':
    case 'reviewed':
      return 'success'
    case 'no_show':
    case 'fail':
    case 'expired':
    case 'unreviewed':
    case 'deletion_requested':
      return 'warning'
    case 'cancelled':
    case 'refunded':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** Only two kinds have somewhere to go. The rest are read in place. */
function href(entry: ClientTimelineEntry): string | null {
  if (entry.kind === 'appointment') return `/dashboard/appointments/${entry.ref}`
  if (entry.kind === 'purchase') return `/dashboard/orders?order=${entry.ref}`
  return null
}

/**
 * Everything that has happened, in order.
 *
 * The feed is one query against `public.client_timeline`, which unions nine
 * tables and reads through security_invoker — so what a caller sees is decided
 * by each source table's own policies, not by anything here. The clinical rows
 * are absent for anyone who may not read them, rather than filtered out after
 * the fact.
 *
 * Grouped by month rather than by day: a client record is read to answer "how
 * often does she come and what happened last time", and a month is the grain
 * that question is actually asked at.
 */
export function ClientTimeline({
  entries,
  timeZone,
  showLocation,
}: {
  entries: ClientTimelineEntry[]
  timeZone: string
  /** Only worth the ink once there is more than one site. */
  showLocation?: Map<number, string>
}) {
  if (entries.length === 0) {
    return <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing on file yet.</p>
  }

  const months: { label: string; rows: ClientTimelineEntry[] }[] = []
  for (const e of entries) {
    const label = new Date(e.occurred_at).toLocaleDateString('en-US', {
      timeZone,
      month: 'long',
      year: 'numeric',
    })
    const last = months[months.length - 1]
    if (last && last.label === label) last.rows.push(e)
    else months.push({ label, rows: [e] })
  }

  return (
    <div className="mt-6 space-y-10">
      {months.map((m) => (
        <div key={m.label}>
          <h3 className="label-caps sticky top-0 z-10 bg-[var(--color-background)] py-2 text-[var(--color-muted)]">
            {m.label}
          </h3>

          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {m.rows.map((e) => {
              const Icon = ICON[e.kind]
              const to = href(e)
              const site = e.location_id ? showLocation?.get(e.location_id) : null

              const body = (
                <div className="flex gap-4 py-4">
                  <Icon
                    className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]"
                    strokeWidth={1.5}
                    aria-hidden
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="label-caps text-[var(--color-muted)]">
                        {KIND_LABEL[e.kind]}
                      </span>
                      <span className="text-xs tabular-nums text-[var(--color-muted)]">
                        {new Date(e.occurred_at).toLocaleDateString('en-US', {
                          timeZone,
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                      {site && <span className="text-xs text-[var(--color-muted)]">{site}</span>}
                    </div>

                    <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed">
                      {e.title}
                    </p>

                    {e.detail && (
                      <p className="mt-1 text-sm text-[var(--color-muted)]">{e.detail}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {e.amount_cents !== null && (
                      <span className="text-sm tabular-nums">{formatMoney(e.amount_cents)}</span>
                    )}
                    {(e.status || e.kind === 'ban' || e.kind === 'ban_lifted') && (
                      <Badge tone={tone(e)} size="sm">
                        {(e.status ?? '').replace(/_/g, ' ') ||
                          (e.kind === 'ban' ? 'stopped' : 'reopened')}
                      </Badge>
                    )}
                  </div>
                </div>
              )

              return (
                <li key={`${e.kind}-${e.ref}-${e.occurred_at}`}>
                  {to ? (
                    <Link href={to} className="block transition-colors hover:text-[var(--color-accent)]">
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
