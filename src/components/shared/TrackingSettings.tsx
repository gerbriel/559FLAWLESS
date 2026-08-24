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

export function TrackingSettings(props: Props) {
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
              <p className="font-medium">Two things to know before pasting</p>
              <p className="mt-1 text-[var(--color-muted)]">
                This code runs on every page of the public site, with the same access
                to it that the site itself has. Only paste something you understand
                and got from a source you trust.
              </p>
              <p className="mt-2 text-[var(--color-muted)]">
                A content security policy also restricts which outside hosts may load
                code here. Google, Meta and TikTok are allowed because the fields
                above need them; a snippet from anywhere else will be refused by the
                browser and simply not run, with the reason named in the developer
                console. Allowing a new one is a code change, not a setting — ask for
                it and it takes a deploy.
              </p>
            </div>
          </div>

          <Field
            label="Custom head JavaScript"
            hint="Runs in the page head. JavaScript only — the <script> tag is added for you, so pasting one produces a broken tag inside a tag."
            htmlFor="head-scripts"
          >
            <Textarea
              id="head-scripts"
              value={headScripts}
              onChange={(e) => setHeadScripts(e.target.value)}
              rows={6}
              placeholder="/* your JavaScript here — no <script> tag */"
            />
          </Field>

          <Field
            label="Custom body JavaScript"
            hint="Runs at the end of the body, after the page has rendered. JavaScript only, same as above."
            htmlFor="body-scripts"
          >
            <Textarea
              id="body-scripts"
              value={bodyScripts}
              onChange={(e) => setBodyScripts(e.target.value)}
              rows={6}
              placeholder="/* your JavaScript here — no <script> tag */"
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
