'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface ScheduleRow {
  id: number
  day_of_week: number
  start_time: string
  end_time: string
  slot_interval_minutes: number
  is_active: boolean
}

interface BlockRow {
  id: number
  block_date: string
  start_time: string | null
  end_time: string | null
  reason: string | null
}

export function ScheduleEditor({
  providerId,
  schedules,
  blocks,
}: {
  providerId: string
  schedules: ScheduleRow[]
  blocks: BlockRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const [newHours, setNewHours] = useState({
    day_of_week: '1',
    start_time: '10:00',
    end_time: '18:00',
    slot_interval_minutes: '15',
  })

  const [newBlock, setNewBlock] = useState({
    block_date: '',
    all_day: true,
    start_time: '12:00',
    end_time: '13:00',
    reason: '',
  })

  async function addHours(e: React.FormEvent) {
    e.preventDefault()

    if (newHours.end_time <= newHours.start_time) {
      toast.error('End time has to be after the start time.')
      return
    }

    setBusy(true)
    const { error } = await createClient().from('provider_schedules').insert({
      provider_id: providerId,
      day_of_week: Number(newHours.day_of_week),
      start_time: newHours.start_time,
      end_time: newHours.end_time,
      slot_interval_minutes: Number(newHours.slot_interval_minutes),
    })
    setBusy(false)

    if (error) {
      toast.error('Could not add those hours.')
      return
    }
    toast.success('Hours added.')
    router.refresh()
  }

  async function removeHours(id: number) {
    const { error } = await createClient().from('provider_schedules').delete().eq('id', id)
    if (error) {
      toast.error('Could not remove that.')
      return
    }
    router.refresh()
  }

  async function addBlock(e: React.FormEvent) {
    e.preventDefault()
    if (!newBlock.block_date) return

    setBusy(true)
    const { error } = await createClient().from('availability_blocks').insert({
      provider_id: providerId,
      block_date: newBlock.block_date,
      start_time: newBlock.all_day ? null : newBlock.start_time,
      end_time: newBlock.all_day ? null : newBlock.end_time,
      // Visible to anyone reading availability — keep it non-personal.
      reason: newBlock.reason.trim() || null,
    })
    setBusy(false)

    if (error) {
      toast.error('Could not add that block.')
      return
    }
    setNewBlock({ ...newBlock, block_date: '', reason: '' })
    toast.success('Time blocked.')
    router.refresh()
  }

  async function removeBlock(id: number) {
    const { error } = await createClient().from('availability_blocks').delete().eq('id', id)
    if (error) {
      toast.error('Could not remove that.')
      return
    }
    router.refresh()
  }

  return (
    <div className="space-y-14">
      {/* ── Weekly hours ──────────────────────────────── */}
      <section>
        <h2 className="display text-2xl">Weekly hours</h2>

        {schedules.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            No hours set — nothing is bookable yet.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {schedules.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-4 py-4">
                <span className="text-sm">
                  <span className="inline-block w-24">{DAYS[s.day_of_week]}</span>
                  <span className="tabular-nums text-[var(--color-muted)]">
                    {s.start_time.slice(0, 5)} – {s.end_time.slice(0, 5)}
                  </span>
                  <span className="ml-3 text-xs text-[var(--color-muted)]">
                    {s.slot_interval_minutes}-min slots
                  </span>
                </span>
                <button
                  onClick={() => removeHours(s.id)}
                  className="p-1.5 text-[var(--color-muted)] hover:text-red-700 dark:hover:text-red-400"
                  aria-label={`Remove ${DAYS[s.day_of_week]} hours`}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={addHours}
          className="mt-6 grid gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:grid-cols-4"
        >
          <Field label="Day" htmlFor="sch_day">
            <Select
              id="sch_day"
              value={newHours.day_of_week}
              onChange={(e) => setNewHours({ ...newHours, day_of_week: e.target.value })}
            >
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" htmlFor="sch_start">
            <Input
              id="sch_start"
              type="time"
              value={newHours.start_time}
              onChange={(e) => setNewHours({ ...newHours, start_time: e.target.value })}
            />
          </Field>
          <Field label="To" htmlFor="sch_end">
            <Input
              id="sch_end"
              type="time"
              value={newHours.end_time}
              onChange={(e) => setNewHours({ ...newHours, end_time: e.target.value })}
            />
          </Field>
          <Field label="Slot every" htmlFor="sch_interval">
            <Select
              id="sch_interval"
              value={newHours.slot_interval_minutes}
              onChange={(e) =>
                setNewHours({ ...newHours, slot_interval_minutes: e.target.value })
              }
            >
              {[10, 15, 20, 30, 60].map((n) => (
                <option key={n} value={n}>
                  {n} min
                </option>
              ))}
            </Select>
          </Field>

          <div className="sm:col-span-4">
            <Button type="submit" size="sm" disabled={busy}>
              Add hours
            </Button>
          </div>
        </form>
      </section>

      {/* ── Time off ──────────────────────────────────── */}
      <section>
        <h2 className="display text-2xl">Time off</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          Blocks are visible to anyone reading availability, so keep the reason general —
          it is only ever rendered as &ldquo;unavailable&rdquo; on the booking page.
        </p>

        {blocks.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing blocked ahead.</p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {blocks.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-4 py-4">
                <span className="text-sm">
                  <span className="inline-block w-32 tabular-nums">
                    {new Date(`${b.block_date}T00:00:00`).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  <span className="text-[var(--color-muted)]">
                    {b.start_time
                      ? `${b.start_time.slice(0, 5)} – ${b.end_time?.slice(0, 5)}`
                      : 'All day'}
                  </span>
                  {b.reason && (
                    <span className="ml-3 text-xs text-[var(--color-muted)]">{b.reason}</span>
                  )}
                </span>
                <button
                  onClick={() => removeBlock(b.id)}
                  className="p-1.5 text-[var(--color-muted)] hover:text-red-700 dark:hover:text-red-400"
                  aria-label="Remove block"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          onSubmit={addBlock}
          className="mt-6 grid gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:grid-cols-2"
        >
          <Field label="Date" htmlFor="blk_date">
            <Input
              id="blk_date"
              type="date"
              required
              value={newBlock.block_date}
              onChange={(e) => setNewBlock({ ...newBlock, block_date: e.target.value })}
            />
          </Field>

          <Field label="Reason" htmlFor="blk_reason" hint="Optional, kept general.">
            <Input
              id="blk_reason"
              maxLength={100}
              value={newBlock.reason}
              onChange={(e) => setNewBlock({ ...newBlock, reason: e.target.value })}
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2.5 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={newBlock.all_day}
              onChange={(e) => setNewBlock({ ...newBlock, all_day: e.target.checked })}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            All day
          </label>

          {!newBlock.all_day && (
            <>
              <Field label="From" htmlFor="blk_start">
                <Input
                  id="blk_start"
                  type="time"
                  value={newBlock.start_time}
                  onChange={(e) => setNewBlock({ ...newBlock, start_time: e.target.value })}
                />
              </Field>
              <Field label="To" htmlFor="blk_end">
                <Input
                  id="blk_end"
                  type="time"
                  value={newBlock.end_time}
                  onChange={(e) => setNewBlock({ ...newBlock, end_time: e.target.value })}
                />
              </Field>
            </>
          )}

          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={busy}>
              Block this time
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}
