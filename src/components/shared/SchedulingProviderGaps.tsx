'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Select } from '@/components/ui/field'
import {
  FRAGMENT_PRESETS,
  GAP_PRESETS,
  MAX_GAP_PRESETS,
  formatMinutes,
  type ProviderSchedulingSettings,
} from '@/types/scheduling'

export interface GapProvider {
  id: string
  name: string
  settings: ProviderSchedulingSettings | null
}

/**
 * One provider's own gap rules, overriding the studio defaults.
 *
 * The row is written on first save rather than seeded for everyone, so "has
 * this person set anything" stays answerable — an absent row means the studio
 * default, and that is a different thing from a row that happens to match it.
 */
export function SchedulingProviderGaps({
  provider,
  locationId,
  studioDefaults,
}: {
  provider: GapProvider
  locationId: number
  studioDefaults: {
    min_gap_minutes: number
    max_gap_minutes: number | null
    min_fragment_minutes: number
  }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const s = provider.settings

  const [form, setForm] = useState({
    min_gap_minutes: String(s?.min_gap_minutes ?? studioDefaults.min_gap_minutes),
    max_gap_minutes:
      (s ? s.max_gap_minutes : studioDefaults.max_gap_minutes) === null
        ? ''
        : String(s ? s.max_gap_minutes : studioDefaults.max_gap_minutes),
    min_fragment_minutes: String(
      s?.min_fragment_minutes ?? studioDefaults.min_fragment_minutes
    ),
  })

  async function save() {
    const minGap = Number(form.min_gap_minutes)
    const maxGap = form.max_gap_minutes === '' ? null : Number(form.max_gap_minutes)
    if (maxGap !== null && maxGap < minGap) {
      toast.error('The most idle time cannot be less than the least.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('provider_scheduling_settings')
      .upsert(
        {
          provider_id: provider.id,
          location_id: locationId,
          min_gap_minutes: minGap,
          max_gap_minutes: maxGap,
          min_fragment_minutes: Number(form.min_fragment_minutes),
        },
        { onConflict: 'provider_id,location_id' }
      )
    setBusy(false)

    if (error) {
      toast.error('Could not save those settings.')
      return
    }

    toast.success('Saved.')
    setOpen(false)
    router.refresh()
  }

  async function clear() {
    setBusy(true)
    const { error } = await createClient()
      .from('provider_scheduling_settings')
      .delete()
      .eq('provider_id', provider.id)
      .eq('location_id', locationId)
    setBusy(false)

    if (error) {
      toast.error('Could not reset those settings.')
      return
    }

    toast.success(`${provider.name} is back on the studio defaults.`)
    setOpen(false)
    router.refresh()
  }

  const summary = s
    ? [
        `at least ${formatMinutes(s.min_gap_minutes)}`,
        s.max_gap_minutes === null ? null : `at most ${formatMinutes(s.max_gap_minutes)}`,
        s.min_fragment_minutes > 0
          ? `no gap under ${formatMinutes(s.min_fragment_minutes)}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null

  return (
    <li className="py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm">{provider.name}</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {summary ?? 'Studio defaults'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {s ? <Badge tone="accent">Own rules</Badge> : <Badge tone="neutral">Default</Badge>}
          <Button variant="subtle" size="sm" onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Edit'}
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-5 space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Least idle" htmlFor={`min_${provider.id}`}>
              <Select
                id={`min_${provider.id}`}
                value={form.min_gap_minutes}
                onChange={(e) => setForm({ ...form, min_gap_minutes: e.target.value })}
              >
                {GAP_PRESETS.map((o) => (
                  <option key={o.minutes} value={String(o.minutes)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Most idle" htmlFor={`max_${provider.id}`}>
              <Select
                id={`max_${provider.id}`}
                value={form.max_gap_minutes}
                onChange={(e) => setForm({ ...form, max_gap_minutes: e.target.value })}
              >
                {MAX_GAP_PRESETS.map((o) => (
                  <option
                    key={String(o.minutes)}
                    value={o.minutes === null ? '' : String(o.minutes)}
                  >
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="No gap under" htmlFor={`frag_${provider.id}`}>
              <Select
                id={`frag_${provider.id}`}
                value={form.min_fragment_minutes}
                onChange={(e) => setForm({ ...form, min_fragment_minutes: e.target.value })}
              >
                {FRAGMENT_PRESETS.map((o) => (
                  <option key={o.minutes} value={String(o.minutes)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            {s && (
              <Button size="sm" variant="ghost" onClick={clear} disabled={busy}>
                Back to studio defaults
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
