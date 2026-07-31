import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Input } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { formatMoney, initials } from '@/lib/utils'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ q?: string }>
}

export default async function ClientsPage({ searchParams }: Props) {
  const { q } = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('profiles')
    .select(
      'id, first_name, last_name, email, phone, created_at, client_records(visit_count, last_visit_at, no_show_count, lifetime_value_cents)'
    )
    .eq('role', 'client')
    .order('created_at', { ascending: false })
    .limit(100)

  if (q?.trim()) {
    const term = `%${q.trim()}%`
    query = query.or(
      `first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`
    )
  }

  const { data: clients } = await query

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Clients</h1>
        <span className="text-sm text-[var(--color-muted)]">
          {clients?.length ?? 0} shown
        </span>
      </div>

      <form className="mt-8 max-w-md">
        <Input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search by name, email, or phone"
          aria-label="Search clients"
        />
      </form>

      {(clients?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          {q ? 'No clients matched that search.' : 'No clients yet.'}
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {(clients ?? []).map((c) => {
            const record = c.client_records as unknown as {
              visit_count: number
              last_visit_at: string | null
              no_show_count: number
              lifetime_value_cents: number
            } | null

            return (
              <li key={c.id}>
                <Link
                  href={`/dashboard/clients/${c.id}`}
                  className="flex flex-wrap items-center gap-x-6 gap-y-3 py-5 transition-colors hover:text-[var(--color-accent)]"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-[var(--color-border)] text-xs">
                    {initials(c.first_name, c.last_name)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p>
                      {c.first_name} {c.last_name}
                    </p>
                    <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                      {c.email}
                      {c.phone && ` · ${c.phone}`}
                    </p>
                  </div>

                  <div className="flex items-center gap-4 text-sm">
                    {(record?.no_show_count ?? 0) > 0 && (
                      <Badge tone="danger">{record!.no_show_count} no-show</Badge>
                    )}
                    <span className="text-[var(--color-muted)]">
                      {record?.visit_count ?? 0} visits
                    </span>
                    <span className="w-20 text-right tabular-nums">
                      {formatMoney(record?.lifetime_value_cents ?? 0)}
                    </span>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
