'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Check, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { DAY_MS } from '@/lib/time'
import {
  INTAKE_MAX_AGE_MS,
  formApplies,
  intakeIsCurrent,
  signatureIsCurrent,
} from '@/lib/forms'

type FormRequirement = {
  id: number
  type: 'intake' | 'consent'
  title: string
  slug: string
  status: 'complete' | 'required' | 'expires_soon'
  expiresAt?: string | null
  lastCompletedAt?: string | null
}

/** How far ahead of an expiry the client is nudged to renew. */
const EXPIRY_WARNING_MS = 30 * DAY_MS

/**
 * The forms a booking requires, and where each one stands.
 *
 * Shown after a booking is taken rather than in front of it: the slot is the
 * commitment, and the paperwork is a condition of being treated on the day —
 * a different deadline. `returnTo` is where each form sends the client back to,
 * so the prompt can be reused anywhere the forms are owed.
 *
 * Which forms apply, and whether one still counts, are decided by `lib/forms`
 * and nothing else. The provider's readiness panel on the approval queue asks
 * the same module the same questions, so the two sides cannot disagree about
 * what is outstanding. They did once, in both directions: this component tested
 * `service_ids.includes(...) || category_ids.includes(...)`, which is false for
 * a studio-wide form — so a general waiver was permanently missing on the
 * provider's card and never once shown to the client who could have cleared it.
 * And it counted any signature at all as done, expired or not.
 *
 * Nothing here gates anything. This lists what is outstanding and links to it;
 * whether a booking is confirmed, held for review, or approved is decided
 * elsewhere and never reads this component's answer. Callers pass `heading` and
 * `intro` to say why the forms are being asked for right now — and a caller
 * whose booking is awaiting approval must not use that copy to imply these are
 * what the approval is waiting on.
 */
export function FormRequirementChecker({
  serviceIds,
  categoryIds,
  onRequirementsChecked,
  returnTo = '/book',
  heading,
  intro,
}: {
  /** Every service on the booking — an appointment can carry several. */
  serviceIds: readonly number[]
  /** Their categories, in any order. Duplicates are fine. */
  categoryIds: readonly number[]
  /**
   * Fires with "nothing is outstanding" — the same line the provider's
   * readiness panel draws, where a signature that is still current but expiring
   * soon counts as held. Pass a stable reference; it is an effect dependency.
   */
  onRequirementsChecked?: (allComplete: boolean) => void
  returnTo?: string
  heading?: string
  intro?: string
}) {
  const [requirements, setRequirements] = useState<FormRequirement[]>([])
  const [loading, setLoading] = useState(true)

  // Arrays are a fresh identity on every render of the parent, so the effect
  // keys off a normalised string and re-derives the ids inside. Depending on
  // the arrays themselves would refetch on every parent render, forever.
  const serviceKey = idKey(serviceIds)
  const categoryKey = idKey(categoryIds)

  useEffect(() => {
    const supabase = createClient()
    let mounted = true

    async function check() {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()

        // Nothing to check against, and nowhere to link them: a guest fills
        // these in at the studio.
        if (!user) return

        const services = parseIdKey(serviceKey)
        const categories = parseIdKey(categoryKey)

        // Four round trips, not one per form. What the client already holds is
        // fetched whole and matched up in memory, the way the approval queue
        // does it — a query inside the loop turned an eight-form studio into
        // eight sequential requests.
        const [
          { data: consentForms },
          { data: intakeForms },
          { data: signatures },
          { data: submissions },
        ] = await Promise.all([
          supabase
            .from('consent_forms')
            .select('id, slug, title, service_ids, category_ids')
            .eq('is_active', true),
          supabase
            .from('intake_forms')
            .select('id, slug, title, service_ids, category_ids')
            .eq('is_active', true),
          supabase
            .from('consent_signatures')
            .select('consent_form_id, signed_at, expires_at')
            .eq('client_id', user.id)
            .order('signed_at', { ascending: false }),
          supabase
            .from('intake_submissions')
            .select('intake_form_id, submitted_at')
            .eq('client_id', user.id)
            .order('submitted_at', { ascending: false }),
        ])

        // Newest first, so the first row seen for a form is the latest one.
        const latestSignature = new Map<
          number,
          { signed_at: string; expires_at: string | null }
        >()
        for (const s of signatures ?? []) {
          if (!latestSignature.has(s.consent_form_id)) {
            latestSignature.set(s.consent_form_id, s)
          }
        }

        const latestSubmission = new Map<number, { submitted_at: string }>()
        for (const s of submissions ?? []) {
          if (!latestSubmission.has(s.intake_form_id)) {
            latestSubmission.set(s.intake_form_id, s)
          }
        }

        // Read once, so every form on this pass is judged against the same
        // instant. (Client component — the server's seam is `requestNow`.)
        const now = Date.now()
        const reqs: FormRequirement[] = []

        for (const form of consentForms ?? []) {
          if (!formApplies(form, services, categories)) continue

          const signature = latestSignature.get(form.id)
          let status: FormRequirement['status'] = 'required'
          if (signature && signatureIsCurrent(signature, now)) {
            status =
              signature.expires_at &&
              new Date(signature.expires_at).getTime() - now <= EXPIRY_WARNING_MS
                ? 'expires_soon'
                : 'complete'
          }

          reqs.push({
            id: form.id,
            type: 'consent',
            title: form.title,
            slug: form.slug,
            status,
            expiresAt: signature?.expires_at ?? null,
            lastCompletedAt: signature?.signed_at ?? null,
          })
        }

        for (const form of intakeForms ?? []) {
          if (!formApplies(form, services, categories)) continue

          const submission = latestSubmission.get(form.id)
          // Intake carries no expiry column of its own — staleness is the
          // shared age limit in lib/forms, which is what the provider's
          // readiness panel judges a health history by too.
          const staleAt = submission
            ? new Date(submission.submitted_at).getTime() + INTAKE_MAX_AGE_MS
            : null
          let status: FormRequirement['status'] = 'required'
          if (staleAt !== null && intakeIsCurrent(submission, now)) {
            status = staleAt - now <= EXPIRY_WARNING_MS ? 'expires_soon' : 'complete'
          }

          reqs.push({
            id: form.id,
            type: 'intake',
            title: form.title,
            slug: form.slug,
            status,
            expiresAt: staleAt === null ? null : new Date(staleAt).toISOString(),
            lastCompletedAt: submission?.submitted_at ?? null,
          })
        }

        if (mounted) {
          setRequirements(reqs)
          onRequirementsChecked?.(!reqs.some((r) => r.status === 'required'))
        }
      } catch (error) {
        console.error('Error checking form requirements:', error)
      } finally {
        if (mounted) setLoading(false)
      }
    }

    void check()

    return () => {
      mounted = false
    }
  }, [serviceKey, categoryKey, onRequirementsChecked])

  if (loading) {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <p className="text-sm text-[var(--color-muted)]">Checking requirements...</p>
      </div>
    )
  }

  if (requirements.length === 0) {
    return null
  }

  const hasRequired = requirements.some((r) => r.status === 'required')
  const hasExpiring = requirements.some((r) => r.status === 'expires_soon')

  return (
    <div
      className={cn(
        'border-l-2 p-6',
        hasRequired
          ? 'border-[var(--color-accent)] bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]'
          : hasExpiring
            ? 'border-[var(--color-clay)] bg-[var(--color-linen)] dark:bg-[var(--color-surface)]'
            : 'border-[var(--color-border)] bg-[var(--color-surface)]'
      )}
    >
      <div className="flex items-start gap-3">
        {hasRequired ? (
          <AlertCircle
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]"
            strokeWidth={1.5}
          />
        ) : hasExpiring ? (
          <Clock
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-clay-deep)]"
            strokeWidth={1.5}
          />
        ) : (
          <Check
            className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]"
            strokeWidth={2}
          />
        )}

        <div className="flex-1">
          <p className="label-caps mb-3 text-[var(--color-foreground)]">
            {heading ??
              (hasRequired
                ? 'Required forms'
                : hasExpiring
                  ? 'Forms expiring soon'
                  : 'All forms complete')}
          </p>

          {intro && <p className="mb-4 text-sm text-[var(--color-muted)]">{intro}</p>}

          <ul className="space-y-3">
            {requirements.map((req) => (
              <li key={`${req.type}-${req.id}`} className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{req.title}</span>
                    {req.status === 'complete' && (
                      <Badge tone="success" size="sm">
                        <Check className="h-2.5 w-2.5" strokeWidth={3} />
                        Complete
                      </Badge>
                    )}
                    {req.status === 'expires_soon' && (
                      <Badge tone="warning" size="sm">
                        <Clock className="h-2.5 w-2.5" strokeWidth={2.5} />
                        Expires soon
                      </Badge>
                    )}
                    {req.status === 'required' && (
                      <Badge tone="danger" size="sm">
                        Required
                      </Badge>
                    )}
                  </div>
                  {req.lastCompletedAt && (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">
                      Last completed {new Date(req.lastCompletedAt).toLocaleDateString()}
                      {/* One that has lapsed is owed again — saying it "expires"
                          on a date already gone by reads as reassurance. */}
                      {req.expiresAt &&
                        ` • ${req.status === 'required' ? 'Expired' : 'Expires'} ${new Date(
                          req.expiresAt
                        ).toLocaleDateString()}`}
                    </p>
                  )}
                </div>

                {(req.status === 'required' || req.status === 'expires_soon') && (
                  <Link href={`/account/forms?form=${req.slug}&return=${encodeURIComponent(returnTo)}`}>
                    <Button size="sm" variant="subtle">
                      {req.status === 'required' ? 'Complete' : 'Renew'}
                    </Button>
                  </Link>
                )}
              </li>
            ))}
          </ul>

          {hasRequired && !intro && (
            <p className="mt-4 text-sm text-[var(--color-muted)]">
              Please complete these before your visit. You will be brought back here
              after each one.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── effect keys ────────────────────────────────────────────
// Sorted and de-duplicated so that the same set of services in a different
// order is the same key, and re-picking a service does not refetch.
function idKey(ids: readonly number[]): string {
  return [...new Set(ids)].sort((a, b) => a - b).join(',')
}

function parseIdKey(key: string): number[] {
  return key ? key.split(',').map(Number) : []
}
