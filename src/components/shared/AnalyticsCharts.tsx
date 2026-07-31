'use client'

import { useState } from 'react'
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts'
import type { TooltipContentProps } from 'recharts'

interface DailyRow {
  date: string
  views: number
  bookings: number
}

interface FunnelRow {
  label: string
  count: number
}

/**
 * Colors come from the validated tokens in globals.css (`.viz-root`), never
 * from raw hex here — light and dark are separately validated sets, so a value
 * changed in one place would silently break the other mode.
 *
 * Text never wears a series color: values and labels stay in ink tokens and the
 * legend swatch beside them carries identity.
 */
export function AnalyticsCharts({
  daily,
  funnel,
}: {
  daily: DailyRow[]
  funnel: FunnelRow[]
}) {
  const [showTable, setShowTable] = useState(false)

  const maxFunnel = Math.max(...funnel.map((f) => f.count), 1)

  return (
    <div className="viz-root space-y-14">
      {/* ── Traffic and bookings over time ────────────── */}
      <figure>
        <figcaption className="mb-1 flex flex-wrap items-baseline justify-between gap-4">
          <h2 className="display text-xl">Pageviews and bookings</h2>
          <button
            onClick={() => setShowTable((s) => !s)}
            className="label-caps text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            {showTable ? 'Show chart' : 'Show table'}
          </button>
        </figcaption>
        <p className="mb-6 text-sm text-[var(--color-muted)]">
          Daily totals. Two measures on one axis — counts of the same kind, so they
          share a scale.
        </p>

        {showTable ? (
          <DailyTable rows={daily} />
        ) : (
          <>
            {/* Legend, always present for two series */}
            <div className="mb-4 flex flex-wrap gap-6">
              <LegendKey color="var(--series-1)" label="Pageviews" />
              <LegendKey color="var(--series-2)" label="Bookings" />
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={daily} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid
                    stroke="var(--chart-grid)"
                    strokeDasharray="0"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tickFormatter={shortDate}
                    stroke="var(--chart-grid)"
                    tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                    tickLine={false}
                    minTickGap={28}
                  />
                  <YAxis
                    stroke="var(--chart-grid)"
                    tick={{ fill: 'var(--chart-axis)', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                    allowDecimals={false}
                  />
                  <Tooltip
                    content={DailyTooltip}
                    cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="views"
                    name="Pageviews"
                    stroke="var(--series-1)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--chart-surface)' }}
                  />
                  <Line
                    type="monotone"
                    dataKey="bookings"
                    name="Bookings"
                    stroke="var(--series-2)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--chart-surface)' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </figure>

      {/* ── Booking funnel ────────────────────────────── */}
      <figure>
        <figcaption className="mb-1">
          <h2 className="display text-xl">Booking funnel</h2>
        </figcaption>
        <p className="mb-6 text-sm text-[var(--color-muted)]">
          Unique sessions reaching each step. One series, so the bars are labelled
          directly and no legend is needed.
        </p>

        <div style={{ height: funnel.length * 52 + 24 }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={funnel}
              layout="vertical"
              margin={{ top: 4, right: 56, bottom: 4, left: 4 }}
              barCategoryGap={10}
            >
              <CartesianGrid stroke="var(--chart-grid)" horizontal={false} />
              <XAxis type="number" hide domain={[0, maxFunnel]} />
              <YAxis
                type="category"
                dataKey="label"
                width={150}
                stroke="var(--chart-grid)"
                tick={{ fill: 'var(--chart-axis)', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={FunnelTooltip} cursor={{ fill: 'var(--chart-grid)' }} />
              <Bar
                dataKey="count"
                fill="var(--seq-1)"
                // Rounded data-end only; the baseline end stays square.
                radius={[0, 4, 4, 0]}
                maxBarSize={22}
              >
                <LabelList
                  dataKey="count"
                  position="right"
                  offset={10}
                  fill="var(--color-foreground)"
                  fontSize={12}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </figure>
    </div>
  )
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
      <span
        className="h-0.5 w-5 shrink-0"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

function DailyTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs shadow-sm">
      <p className="mb-1.5 text-[var(--color-muted)]">{longDate(String(label))}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2">
          <span
            className="h-0.5 w-3"
            style={{ backgroundColor: p.color }}
            aria-hidden="true"
          />
          <span className="text-[var(--color-muted)]">{p.name}</span>
          <span className="ml-auto tabular-nums">{p.value}</span>
        </p>
      ))}
    </div>
  )
}

function FunnelTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]
  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs shadow-sm">
      <span className="text-[var(--color-muted)]">
        {(row.payload as FunnelRow).label}
      </span>
      <span className="ml-3 tabular-nums">{row.value} sessions</span>
    </div>
  )
}

function DailyTable({ rows }: { rows: DailyRow[] }) {
  return (
    <div className="max-h-80 overflow-auto border border-[var(--color-border)]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-[var(--color-surface)]">
          <tr className="border-b border-[var(--color-border)]">
            <th className="label-caps px-4 py-3 text-left text-[var(--color-muted)]">Date</th>
            <th className="label-caps px-4 py-3 text-right text-[var(--color-muted)]">
              Pageviews
            </th>
            <th className="label-caps px-4 py-3 text-right text-[var(--color-muted)]">
              Bookings
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.date} className="border-b border-[var(--color-border)] last:border-0">
              <td className="px-4 py-2">{longDate(r.date)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.views}</td>
              <td className="px-4 py-2 text-right tabular-nums">{r.bookings}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function shortDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  })
}

function longDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
