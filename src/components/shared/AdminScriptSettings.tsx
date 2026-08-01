'use client'

import type { Json } from '@/types/database'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Textarea, Field } from '@/components/ui/field'
import { createClient } from '@/lib/supabase/client'
import { AlertTriangle } from 'lucide-react'

interface Props {
  googleAnalyticsId: string
  googleTagManagerId: string
  facebookPixelId: string
  tiktokPixelId: string
  customHeadScripts: string
  customBodyScripts: string
}

export function AdminScriptSettings(props: Props) {
  const router = useRouter()
  const [gaId, setGaId] = useState(props.googleAnalyticsId)
  const [gtmId, setGtmId] = useState(props.googleTagManagerId)
  const [fbPixel, setFbPixel] = useState(props.facebookPixelId)
  const [tiktokPixel, setTiktokPixel] = useState(props.tiktokPixelId)
  const [headScripts, setHeadScripts] = useState(props.customHeadScripts)
  const [bodyScripts, setBodyScripts] = useState(props.customBodyScripts)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSave = async () => {
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const supabase = createClient()

      // Typed explicitly: the array mixes {id} and {scripts} value shapes, and
      // TS infers a union that will not satisfy the jsonb column on its own.
      const updates: { key: string; value: Json; label: string }[] = [
        {
          key: 'google_analytics_id',
          value: { id: gaId.trim() },
          label: 'Google Analytics ID',
        },
        {
          key: 'google_tag_manager_id',
          value: { id: gtmId.trim() },
          label: 'Google Tag Manager ID',
        },
        {
          key: 'facebook_pixel_id',
          value: { id: fbPixel.trim() },
          label: 'Facebook Pixel ID',
        },
        {
          key: 'tiktok_pixel_id',
          value: { id: tiktokPixel.trim() },
          label: 'TikTok Pixel ID',
        },
        {
          key: 'custom_head_scripts',
          value: { scripts: headScripts.trim() },
          label: 'Custom Head Scripts',
        },
        {
          key: 'custom_body_scripts',
          value: { scripts: bodyScripts.trim() },
          label: 'Custom Body Scripts',
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
      {/* Standard Tracking */}
      <Card>
        <CardHeader>
          <CardTitle>Standard Tracking Platforms</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Google Analytics ID"
            hint="Format: G-XXXXXXXXXX or UA-XXXXXXXXX-X"
            htmlFor="ga"
          >
            <Input
              id="ga"
              value={gaId}
              onChange={(e) => setGaId(e.target.value)}
              placeholder="G-XXXXXXXXXX"
            />
          </Field>

          <Field
            label="Google Tag Manager ID"
            hint="Format: GTM-XXXXXXX"
            htmlFor="gtm"
          >
            <Input
              id="gtm"
              value={gtmId}
              onChange={(e) => setGtmId(e.target.value)}
              placeholder="GTM-XXXXXXX"
            />
          </Field>

          <Field
            label="Facebook Pixel ID"
            hint="Numeric ID from your Facebook Events Manager"
            htmlFor="fb"
          >
            <Input
              id="fb"
              value={fbPixel}
              onChange={(e) => setFbPixel(e.target.value)}
              placeholder="123456789012345"
            />
          </Field>

          <Field
            label="TikTok Pixel ID"
            hint="Find this in your TikTok Events Manager"
            htmlFor="tiktok"
          >
            <Input
              id="tiktok"
              value={tiktokPixel}
              onChange={(e) => setTiktokPixel(e.target.value)}
              placeholder="XXXXXXXXXXXXXX"
            />
          </Field>
        </CardContent>
      </Card>

      {/* Custom Scripts */}
      <Card>
        <CardHeader>
          <CardTitle>Custom Scripts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium">Use with caution</p>
              <p className="mt-1 text-[var(--color-muted)]">
                Custom scripts are injected directly into the page. Only add scripts from trusted sources.
                Malicious scripts can compromise security and user data.
              </p>
            </div>
          </div>

          <Field
            label="Custom Head Scripts"
            hint="Scripts to inject in <head>. Include <script> tags."
            htmlFor="head-scripts"
          >
            <Textarea
              id="head-scripts"
              value={headScripts}
              onChange={(e) => setHeadScripts(e.target.value)}
              rows={6}
              placeholder="<script>/* your script here */</script>"
            />
          </Field>

          <Field
            label="Custom Body Scripts"
            hint="Scripts to inject at end of <body>. Include <script> tags."
            htmlFor="body-scripts"
          >
            <Textarea
              id="body-scripts"
              value={bodyScripts}
              onChange={(e) => setBodyScripts(e.target.value)}
              rows={6}
              placeholder="<script>/* your script here */</script>"
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
