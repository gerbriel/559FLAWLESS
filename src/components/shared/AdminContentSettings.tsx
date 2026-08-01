'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea, Field } from '@/components/ui/field'
import { createClient } from '@/lib/supabase/client'

interface Props {
  privacyPolicy: string
  termsOfService: string
}

export function AdminContentSettings({ privacyPolicy, termsOfService }: Props) {
  const router = useRouter()
  const [privacy, setPrivacy] = useState(privacyPolicy)
  const [terms, setTerms] = useState(termsOfService)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSave = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const supabase = createClient()

      // Update both privacy policy and terms
      const updates = [
        {
          key: 'privacy_policy',
          value: { text: privacy, version: Date.now() },
          label: 'Privacy Policy',
        },
        {
          key: 'terms_of_service',
          value: { text: terms, version: Date.now() },
          label: 'Terms of Service',
        },
      ]

      for (const update of updates) {
        const { error: upsertError } = await supabase
          .from('site_content')
          .upsert(update, { onConflict: 'key' })

        if (upsertError) throw upsertError
      }

      setSuccess(true)
      router.refresh()
      
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Privacy Policy</CardTitle>
        </CardHeader>
        <CardContent>
          <Field
            label="Privacy Policy Text"
            hint="Supports Markdown. This will be displayed at /privacy"
            htmlFor="privacy"
          >
            <Textarea
              id="privacy"
              value={privacy}
              onChange={(e) => setPrivacy(e.target.value)}
              rows={12}
              placeholder="Enter your privacy policy..."
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Terms of Service</CardTitle>
        </CardHeader>
        <CardContent>
          <Field
            label="Terms of Service Text"
            hint="Supports Markdown. This will be displayed at /terms"
            htmlFor="terms"
          >
            <Textarea
              id="terms"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={12}
              placeholder="Enter your terms of service..."
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-6">
        <div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {success && <p className="text-sm text-green-600">Saved successfully!</p>}
        </div>
        <Button onClick={handleSave} disabled={loading}>
          {loading ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  )
}
