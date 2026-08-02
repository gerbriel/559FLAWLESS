import { redirect } from 'next/navigation'
import { FileText, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import {
  ConsentFormEditor,
  type EditableConsentForm,
} from '@/components/shared/ConsentFormEditor'
import { isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The consent forms clients are asked to sign.
 *
 * Superseded versions stay listed rather than disappearing — the point of
 * versioning a consent form is being able to read back what someone agreed to,
 * and a version that has vanished from the UI is one nobody can check.
 */
export default async function ConsentFormsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!isManager((profile?.role ?? 'provider') as UserRole)) redirect('/dashboard')

  const [{ data: forms }, { data: categories }, { data: signatures }] = await Promise.all([
    supabase
      .from('consent_forms')
      .select(
        'id, slug, version, title, body, requires_initials, revalidate_after_days, is_active, service_ids, category_ids, created_at'
      )
      .order('slug')
      .order('version', { ascending: false }),
    supabase
      .from('service_categories')
      .select('id, name')
      .eq('is_active', true)
      .order('sort_order'),
    supabase.from('consent_signatures').select('consent_form_id').limit(5000),
  ])

  // How many people signed each specific version.
  const signedCount = new Map<number, number>()
  for (const s of signatures ?? []) {
    signedCount.set(s.consent_form_id, (signedCount.get(s.consent_form_id) ?? 0) + 1)
  }

  const rows: EditableConsentForm[] = (forms ?? []).map((f) => ({
    id: f.id,
    slug: f.slug,
    version: f.version,
    title: f.title,
    body: f.body,
    requires_initials: f.requires_initials,
    revalidate_after_days: f.revalidate_after_days,
    is_active: f.is_active,
    service_ids: f.service_ids ?? [],
    category_ids: f.category_ids ?? [],
    signature_count: signedCount.get(f.id) ?? 0,
  }))

  const options = (categories ?? []).map((c) => ({ id: c.id, name: c.name }))

  // Group by slug so every version of a form sits together.
  const bySlug = new Map<string, EditableConsentForm[]>()
  for (const r of rows) {
    bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r])
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <p className="max-w-prose text-sm text-[var(--color-muted)]">
          What clients read and agree to before treatment. Once a version has been
          signed its wording is fixed — editing it publishes a new version and keeps
          the old one on record.
        </p>
        <ConsentFormEditor categories={options} />
      </div>

      {bySlug.size === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No consent forms yet.
        </p>
      ) : (
        <div className="mt-10 space-y-10">
          {[...bySlug.entries()].map(([slug, versions]) => {
            const current = versions.find((v) => v.is_active) ?? versions[0]
            const superseded = versions.filter((v) => v.id !== current.id)

            return (
              <section key={slug} className="border border-[var(--color-border)] bg-[var(--color-surface)]">
                <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] p-6">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileText
                        className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
                        strokeWidth={1.5}
                      />
                      <h2 className="display text-xl">{current.title}</h2>
                      <Badge tone="neutral">v{current.version}</Badge>
                      {!current.is_active && <Badge tone="warning">Not in use</Badge>}
                      {current.signature_count > 0 && (
                        <Badge tone="success">
                          <Lock className="h-3 w-3" strokeWidth={2} />
                          {current.signature_count} signed
                        </Badge>
                      )}
                    </div>
                    <p className="mt-2 line-clamp-2 max-w-prose text-sm text-[var(--color-muted)]">
                      {current.body}
                    </p>
                    <p className="mt-2 text-xs text-[var(--color-muted)]">
                      Re-signed every {current.revalidate_after_days} days
                      {current.requires_initials ? ' · initials required' : ''}
                    </p>
                  </div>

                  <ConsentFormEditor form={current} categories={options} />
                </div>

                {superseded.length > 0 && (
                  <div className="p-6">
                    <p className="label-caps mb-3 text-[var(--color-muted)]">
                      Earlier versions
                    </p>
                    <ul className="space-y-2">
                      {superseded.map((v) => (
                        <li
                          key={v.id}
                          className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--color-muted)]"
                        >
                          <span>
                            v{v.version} — {v.title}
                          </span>
                          <span className="text-xs">
                            {v.signature_count > 0
                              ? `${v.signature_count} signature${v.signature_count === 1 ? '' : 's'} still on record`
                              : 'never signed'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
