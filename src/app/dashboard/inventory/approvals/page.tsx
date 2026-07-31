import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { ApprovalRow } from '@/components/shared/ApprovalRow'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ status?: string }>
}

const FILTERS = ['pending', 'approved', 'rejected']

export default async function ApprovalsPage({ searchParams }: Props) {
  const { status } = await searchParams
  const active = FILTERS.includes(status ?? '') ? status! : 'pending'

  const supabase = await createClient()

  const { data: requests } = await supabase
    .from('inventory_change_requests')
    .select(
      'id, entry_type, target_table, operation, target_id, old_value, new_value, summary, reason, status, created_at, reviewed_at, review_note, profiles!inventory_change_requests_requested_by_fkey(first_name, last_name)'
    )
    .eq('status', active as 'pending' | 'approved' | 'rejected')
    .order('created_at', { ascending: false })
    .limit(100)

  return (
    <div>
      <h1 className="display text-3xl">Inventory approvals</h1>
      <p className="mt-3 max-w-2xl text-sm text-[var(--color-muted)]">
        Providers and front desk propose stock changes here rather than editing
        directly. Approving applies the change and writes the movement log.
      </p>

      <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/dashboard/inventory/approvals?status=${f}`}
            className={`label-caps pb-1 capitalize ${
              active === f
                ? 'border-b border-[var(--color-foreground)]'
                : 'text-[var(--color-muted)]'
            }`}
          >
            {f}
          </Link>
        ))}
      </nav>

      {(requests?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          {active === 'pending' ? 'Nothing waiting on you.' : `No ${active} requests.`}
        </p>
      ) : (
        <ul className="mt-8 space-y-4">
          {(requests ?? []).map((r) => {
            const who = r.profiles as {
              first_name: string | null
              last_name: string | null
            } | null

            return (
              <li key={r.id}>
                <ApprovalRow
                  request={{
                    id: r.id,
                    summary: r.summary,
                    reason: r.reason,
                    status: r.status,
                    target_table: r.target_table,
                    target_id: r.target_id,
                    old_value: r.old_value,
                    new_value: r.new_value,
                    created_at: r.created_at,
                    review_note: r.review_note,
                  }}
                  requestedBy={
                    who ? `${who.first_name ?? ''} ${who.last_name ?? ''}`.trim() : 'Unknown'
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
