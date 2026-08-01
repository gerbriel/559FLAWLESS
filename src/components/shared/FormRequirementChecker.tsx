'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Check, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type FormRequirement = {
  id: number
  type: 'intake' | 'consent'
  title: string
  slug: string
  status: 'complete' | 'required' | 'expires_soon'
  expiresAt?: string | null
  lastCompletedAt?: string | null
}

/**
 * The forms a service requires, and where each one stands.
 *
 * Shown after a booking is confirmed rather than before it: the slot is the
 * commitment, and the paperwork is a condition of being treated on the day —
 * a different deadline. `returnTo` is where each form sends the client back to,
 * so the prompt can be reused anywhere the forms are owed.
 */
export function FormRequirementChecker({
  serviceId,
  categoryId,
  onRequirementsChecked,
  returnTo = '/book',
  heading,
  intro,
}: {
  serviceId: number
  categoryId: number
  onRequirementsChecked?: (allComplete: boolean) => void
  returnTo?: string
  heading?: string
  intro?: string
}) {
  const [requirements, setRequirements] = useState<FormRequirement[]>([])
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    let mounted = true

    async function check() {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser()

        if (!user) {
          setLoading(false)
          return
        }

        setUserId(user.id)

        // Fetch required consent forms
        const { data: consentForms } = await supabase
          .from('consent_forms')
          .select('id, slug, title, revalidate_after_days, service_ids, category_ids')
          .eq('is_active', true)

        // Fetch required intake forms
        const { data: intakeForms } = await supabase
          .from('intake_forms')
          .select('id, slug, title, service_ids, category_ids')
          .eq('is_active', true)

        const reqs: FormRequirement[] = []

        // Check consent forms
        if (consentForms) {
          for (const form of consentForms) {
            const requiresThisForm =
              form.service_ids.includes(serviceId) ||
              form.category_ids.includes(categoryId)

            if (requiresThisForm) {
              // Check if already signed
              const { data: signature } = await supabase
                .from('consent_signatures')
                .select('signed_at, expires_at')
                .eq('consent_form_id', form.id)
                .eq('client_id', user.id)
                .order('signed_at', { ascending: false })
                .limit(1)
                .maybeSingle()

              let status: FormRequirement['status'] = 'required'
              const expiresAt = signature?.expires_at
              const lastCompletedAt = signature?.signed_at

              if (signature) {
                if (signature.expires_at) {
                  const expiry = new Date(signature.expires_at)
                  const now = new Date()
                  const daysUntilExpiry = Math.floor(
                    (expiry.getTime() - now.getTime()) / 86_400_000
                  )

                  if (daysUntilExpiry < 0) {
                    status = 'required'
                  } else if (daysUntilExpiry <= 30) {
                    status = 'expires_soon'
                  } else {
                    status = 'complete'
                  }
                } else {
                  status = 'complete'
                }
              }

              reqs.push({
                id: form.id,
                type: 'consent',
                title: form.title,
                slug: form.slug,
                status,
                expiresAt,
                lastCompletedAt,
              })
            }
          }
        }

        // Check intake forms
        if (intakeForms) {
          for (const form of intakeForms) {
            const requiresThisForm =
              form.service_ids.includes(serviceId) ||
              form.category_ids.includes(categoryId)

            if (requiresThisForm) {
              // Check if already submitted
              const { data: submission } = await supabase
                .from('intake_submissions')
                .select('submitted_at')
                .eq('intake_form_id', form.id)
                .eq('client_id', user.id)
                .order('submitted_at', { ascending: false })
                .limit(1)
                .maybeSingle()

              reqs.push({
                id: form.id,
                type: 'intake',
                title: form.title,
                slug: form.slug,
                status: submission ? 'complete' : 'required',
                lastCompletedAt: submission?.submitted_at,
              })
            }
          }
        }

        if (mounted) {
          setRequirements(reqs)
          const allComplete = reqs.every((r) => r.status === 'complete')
          onRequirementsChecked?.(allComplete)
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
  }, [serviceId, categoryId, onRequirementsChecked])

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
                      {req.expiresAt &&
                        ` • Expires ${new Date(req.expiresAt).toLocaleDateString()}`}
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
