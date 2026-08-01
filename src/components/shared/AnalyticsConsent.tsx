'use client'

import { useState, useEffect } from 'react'
import { Field } from '@/components/ui/field'
import { getAnalyticsConsent, setAnalyticsConsent } from './ClientAnalytics'

/**
 * Analytics consent toggle for user privacy settings.
 * Allows users to opt out of behavioral tracking while maintaining
 * transactional functionality (bookings, forms, etc.).
 */
export function AnalyticsConsent() {
  const [enabled, setEnabled] = useState(true)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setEnabled(getAnalyticsConsent())
    setMounted(true)
  }, [])

  function handleChange(checked: boolean) {
    setEnabled(checked)
    setAnalyticsConsent(checked)
  }

  if (!mounted) return null

  return (
    <Field
      label="Analytics tracking"
      htmlFor="analytics_consent"
      hint="We collect anonymous usage data to improve the site. You can opt out anytime."
    >
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          id="analytics_consent"
          checked={enabled}
          onChange={(e) => handleChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
        <span className="text-sm">
          {enabled
            ? 'Analytics enabled — we track page visits to improve the site'
            : 'Analytics disabled — we do not track your browsing'}
        </span>
      </label>
    </Field>
  )
}
