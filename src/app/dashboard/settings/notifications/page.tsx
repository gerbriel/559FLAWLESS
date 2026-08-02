import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { NotificationTemplateEditor } from '@/components/shared/NotificationTemplateEditor'
import {
  NotificationScheduleList,
  type ScopeOption,
} from '@/components/shared/NotificationScheduleList'
import { NotificationDispatchNow } from '@/components/shared/NotificationDispatchNow'
import {
  NotificationQueueTable,
  type QueueRow,
} from '@/components/shared/NotificationQueueTable'
import { isManager } from '@/types/database'
import {
  KIND_LABELS,
  NOTIFICATION_KINDS,
  SCHEDULED_KINDS,
  type NotificationKind,
  type NotificationSchedule,
  type NotificationTemplate,
} from '@/types/notifications'

export const dynamic = 'force-dynamic'

export default async function NotificationSettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  // Wording and timing are settings, and settings are the manager's. Providers
  // and the front desk can see what goes out; they do not rewrite it.
  if (!profile || profile.suspended_at || !isManager(profile.role)) {
    redirect('/dashboard')
  }

  const [
    { data: templates },
    { data: schedules },
    { data: services },
    { data: categories },
    { data: location },
    { data: queue },
  ] = await Promise.all([
    supabase
      .from('notification_templates')
      .select('id, location_id, kind, channel, title_template, body_template, link_template, opens_thread, is_active, updated_by, created_at, updated_at')
      .order('kind'),
    supabase
      .from('notification_schedules')
      .select('id, location_id, kind, label, anchor, offset_minutes, send_at_local, service_id, category_id, is_active, created_at, updated_at')
      .order('offset_minutes'),
    supabase.from('services').select('id, name').eq('is_active', true).order('name'),
    supabase.from('service_categories').select('id, name').eq('is_active', true).order('sort_order'),
    supabase.from('locations').select('id, name, timezone').order('sort_order').limit(1).maybeSingle(),
    supabase
      .from('notification_queue')
      .select('id, kind, category, channel, status, scheduled_for, title, skipped_reason, profiles!notification_queue_recipient_id_fkey(first_name, last_name)')
      .order('scheduled_for', { ascending: false })
      .limit(25),
  ])

  const timeZone = location?.timezone ?? 'America/Los_Angeles'
  const allTemplates = (templates ?? []) as NotificationTemplate[]
  const allSchedules = (schedules ?? []) as NotificationSchedule[]
  const serviceOptions = (services ?? []) as ScopeOption[]
  const categoryOptions = (categories ?? []) as ScopeOption[]

  const queueRows: QueueRow[] = (queue ?? []).map((row) => {
    const who = row.profiles as { first_name: string | null; last_name: string | null } | null
    return {
      id: row.id,
      kind: row.kind,
      category: row.category,
      channel: row.channel,
      status: row.status,
      scheduled_for: row.scheduled_for,
      title: row.title,
      skipped_reason: row.skipped_reason,
      recipient: [who?.first_name, who?.last_name].filter(Boolean).join(' ') || 'A client',
    }
  })

  const eventKinds = NOTIFICATION_KINDS.filter((k) => !SCHEDULED_KINDS.includes(k))

  return (
    <div className="max-w-3xl">
      <h1 className="display text-3xl">Client notifications</h1>
      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        Everything the studio says to a client automatically — what it says, and when.
        These arrive in the client&rsquo;s account here on the site. There is no email or
        text provider connected yet; when there is, the same wording and the same timing
        will drive it.
      </p>

      <section className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="label-caps text-[var(--color-muted)]">Sending</p>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          Messages go out on a scheduled sweep. Pressing this runs one now — it will
          not send anyone the same thing twice, so it is safe to press whenever you
          are not sure.
        </p>
        <div className="mt-4">
          <NotificationDispatchNow />
        </div>
      </section>

      <section className="mt-14">
        <h2 className="display text-2xl">What each message says</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Write these however you speak. Anything in double braces is filled in when it
          sends; a word we do not recognise is left in the message exactly as you typed
          it, rather than disappearing.
        </p>

        <div className="mt-6">
          <p className="label-caps text-[var(--color-muted)]">Sent as it happens</p>
          <div className="mt-2 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {eventKinds.map((kind) => {
              const template = allTemplates.find((t) => t.kind === kind)
              return template ? (
                <NotificationTemplateEditor key={kind} template={template} />
              ) : (
                <MissingTemplate key={kind} kind={kind} />
              )
            })}
          </div>
        </div>

        <div className="mt-10">
          <p className="label-caps text-[var(--color-muted)]">Sent on a schedule</p>
          <div className="mt-2 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {SCHEDULED_KINDS.map((kind) => {
              const template = allTemplates.find((t) => t.kind === kind)
              return template ? (
                <NotificationTemplateEditor key={kind} template={template} />
              ) : (
                <MissingTemplate key={kind} kind={kind} />
              )
            })}
          </div>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="display text-2xl">When they go out</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Each line is one send. Add a second to remind twice. Times are {timeZone.replace('_', ' ')}.
        </p>

        <div className="mt-8 space-y-10">
          {SCHEDULED_KINDS.map((kind) => (
            <div key={kind}>
              <h3 className="flex flex-wrap items-center gap-2 text-sm">
                {KIND_LABELS[kind]}
                {kind === 'rebooking_nudge' && (
                  <Badge tone="warning" size="sm">
                    Marketing
                  </Badge>
                )}
              </h3>
              {kind === 'rebooking_nudge' && (
                <p className="mt-1 max-w-prose text-xs text-[var(--color-muted)]">
                  Only goes to clients who have opted in to hearing from you, and never
                  to anyone who already has an appointment booked.
                </p>
              )}
              <div className="mt-4">
                <NotificationScheduleList
                  kind={kind}
                  anchorMode={kind === 'rebooking_nudge' ? 'last_visit' : 'appointment'}
                  schedules={allSchedules.filter((s) => s.kind === kind)}
                  services={serviceOptions}
                  categories={categoryOptions}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="display text-2xl">Recently sent</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Including the ones that were held back, and why.
        </p>
        <div className="mt-6">
          <NotificationQueueTable rows={queueRows} timeZone={timeZone} />
        </div>
      </section>
    </div>
  )
}

function MissingTemplate({ kind }: { kind: NotificationKind }) {
  return (
    <div className="py-6">
      <p className="text-sm">{KIND_LABELS[kind]}</p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        No wording yet, so nothing is sent for this. Re-run migration 038 to restore the
        default.
      </p>
    </div>
  )
}
