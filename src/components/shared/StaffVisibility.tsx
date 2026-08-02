'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CalendarCheck, Globe } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

export interface StaffVisibilityRow {
  id: string
  name: string
  /** profiles.accepts_online_booking — appears on /book as someone to book. */
  bookable: boolean
  /** staff_profiles.is_public — appears on /team as a face on the website. */
  listed: boolean
}

/**
 * The two ways a staff member can appear to the public, as two switches.
 *
 * They are genuinely different questions and conflating them is how someone
 * ends up on the internet by accident:
 *
 *   Bookable  — a client can pick this person and reserve their time.
 *   Listed    — this person's photograph and biography are on the team page.
 *
 * A studio might want either without the other. The owner who does treatments
 * is bookable but may not want a public profile; a front-desk lead belongs on
 * the team page and must never be bookable.
 *
 * Both default to OFF. Nothing about being an admin, a manager or a provider
 * puts anyone on the public site — that is always a deliberate act, which is
 * what these switches make it.
 */
export function StaffVisibility({
  rows,
  viewerId,
  viewerIsAdmin,
}: {
  rows: StaffVisibilityRow[]
  viewerId: string
  /** Only an admin may change someone else's; anyone may change their own. */
  viewerIsAdmin: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  // Optimistic, keyed by `${id}:${field}` so two switches on one row are independent.
  const [pending, setPending] = useState<Record<string, boolean>>({})

  async function toggle(row: StaffVisibilityRow, field: 'bookable' | 'listed', next: boolean) {
    const key = `${row.id}:${field}`
    setBusy(key)
    setPending((p) => ({ ...p, [key]: next }))

    const supabase = createClient()
    const { error } =
      field === 'bookable'
        ? await supabase
            .from('profiles')
            .update({ accepts_online_booking: next })
            .eq('id', row.id)
        : await supabase
            .from('staff_profiles')
            .update({ is_public: next })
            .eq('profile_id', row.id)

    setBusy(null)

    if (error) {
      // Roll the switch back rather than leave it showing a state the database
      // does not hold.
      setPending((p) => {
        const { [key]: _dropped, ...rest } = p
        void _dropped
        return rest
      })
      toast.error(
        error.message.includes('policy') || error.code === '42501'
          ? 'You can only change your own. Ask an admin for anyone else.'
          : 'Could not save that.'
      )
      return
    }

    toast.success(
      field === 'bookable'
        ? next
          ? `${row.name} can be booked online.`
          : `${row.name} is no longer bookable online.`
        : next
          ? `${row.name} is on the team page.`
          : `${row.name} is off the team page.`
    )
    router.refresh()
  }

  const valueOf = (row: StaffVisibilityRow, field: 'bookable' | 'listed') =>
    pending[`${row.id}:${field}`] ?? row[field]

  return (
    <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
      {rows.map((row) => {
        const mine = row.id === viewerId

        return (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
            <span className="text-sm">
              {row.name}
              {mine && <span className="ml-2 text-xs text-[var(--color-muted)]">(you)</span>}
            </span>

            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {(
                [
                  {
                    field: 'bookable' as const,
                    icon: CalendarCheck,
                    label: 'Bookable online',
                    hint: 'Clients can pick them and reserve a time.',
                  },
                  {
                    field: 'listed' as const,
                    icon: Globe,
                    label: 'On the team page',
                    hint: 'Their photo and bio are on the public website.',
                  },
                ]
              ).map(({ field, icon: Icon, label, hint }) => {
                const on = valueOf(row, field)
                const key = `${row.id}:${field}`

                /**
                 * Mirrors the database rule from migration 045, so nobody is
                 * offered a switch that will refuse them:
                 *   on  — an admin decision; the studio chooses whose time it
                 *         offers to the public.
                 *   off — always yours to do. Someone ill, leaving or simply
                 *         full should not have to find an admin to stop taking
                 *         new bookings.
                 * The team page (`is_public`) is self-service both ways: taking
                 * your own face off a website is not a request.
                 */
                const mayEdit =
                  field === 'listed'
                    ? mine || viewerIsAdmin
                    : viewerIsAdmin || (mine && on)

                const why = !mayEdit
                  ? mine
                    ? 'Ask an admin to put you on the booking page. You can take yourself off at any time.'
                    : 'Only an admin can change this for someone else.'
                  : hint

                return (
                  <label
                    key={field}
                    title={why}
                    className={`flex min-h-11 cursor-pointer items-center gap-2.5 text-sm ${
                      mayEdit ? '' : 'cursor-not-allowed opacity-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!mayEdit || busy === key}
                      onChange={(e) => toggle(row, field, e.target.checked)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <Icon
                      className={`h-3.5 w-3.5 ${
                        on ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'
                      }`}
                      strokeWidth={1.75}
                    />
                    <span className={on ? '' : 'text-[var(--color-muted)]'}>{label}</span>
                  </label>
                )
              })}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
