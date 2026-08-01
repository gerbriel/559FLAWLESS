'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'

interface SiteSetting {
  id: number
  key: string
  type: string
  version: number
  text_value: string | null
  label: string | null
  effective_at: string | null
  is_active: boolean
}

interface TermsEditorProps {
  setting: SiteSetting | null
  settingKey: 'terms_of_service' | 'privacy_policy'
  label: string
}

export function LegalContentEditor({ setting, settingKey, label }: TermsEditorProps) {
  const router = useRouter()
  const [form, setForm] = useState({
    text_value: setting?.text_value || '',
    effective_at: setting?.effective_at
      ? new Date(setting.effective_at).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0],
  })
  const [busy, setBusy] = useState(false)
  const [publishing, setPublishing] = useState(false)

  async function saveDraft() {
    setBusy(true)
    const supabase = createClient()

    if (setting) {
      // Update existing
      const { error } = await supabase
        .from('site_settings')
        .update({
          text_value: form.text_value,
          effective_at: form.effective_at,
        })
        .eq('id', setting.id)

      if (error) {
        toast.error('Could not save draft.')
        console.error(error)
      } else {
        toast.success('Draft saved.')
        router.refresh()
      }
    } else {
      // Create new version
      const nextVersion = 1
      const { error } = await supabase.from('site_settings').insert({
        key: settingKey,
        type: 'policy',
        version: nextVersion,
        text_value: form.text_value,
        label,
        effective_at: form.effective_at,
        is_active: false, // Draft
      })

      if (error) {
        toast.error('Could not create draft.')
        console.error(error)
      } else {
        toast.success('Draft created.')
        router.refresh()
      }
    }

    setBusy(false)
  }

  async function publishVersion() {
    if (
      !confirm(
        `This will publish version ${setting?.version || 1} and supersede any previous version. Continue?`
      )
    ) {
      return
    }

    setPublishing(true)
    const supabase = createClient()

    // Deactivate previous versions
    await supabase
      .from('site_settings')
      .update({ is_active: false, superseded_at: new Date().toISOString() })
      .eq('key', settingKey)
      .eq('is_active', true)

    // Activate this version
    const { error } = await supabase
      .from('site_settings')
      .update({ is_active: true })
      .eq('id', setting!.id)

    if (error) {
      toast.error('Could not publish.')
      console.error(error)
    } else {
      toast.success('Published!')
      router.refresh()
    }

    setPublishing(false)
  }

  async function createNewVersion() {
    setBusy(true)
    const supabase = createClient()

    // Get current max version
    const { data: latest } = await supabase
      .from('site_settings')
      .select('version')
      .eq('key', settingKey)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    const nextVersion = (latest?.version || 0) + 1

    const { error } = await supabase.from('site_settings').insert({
      key: settingKey,
      type: 'policy',
      version: nextVersion,
      text_value: form.text_value,
      label,
      effective_at: form.effective_at,
      is_active: false,
    })

    if (error) {
      toast.error('Could not create new version.')
      console.error(error)
    } else {
      toast.success(`Version ${nextVersion} created as draft.`)
      router.refresh()
    }

    setBusy(false)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="display text-2xl">{label}</h2>
          {setting && (
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              Version {setting.version} •{' '}
              {setting.is_active ? (
                <span className="text-green-600 dark:text-green-400">Published</span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">Draft</span>
              )}
            </p>
          )}
        </div>
        {setting && !setting.is_active && (
          <Button onClick={publishVersion} disabled={publishing} variant="accent">
            {publishing ? 'Publishing…' : 'Publish Version'}
          </Button>
        )}
      </div>

      <Field label="Effective Date" htmlFor={`${settingKey}_date`}>
        <Input
          type="date"
          id={`${settingKey}_date`}
          value={form.effective_at}
          onChange={(e) => setForm({ ...form, effective_at: e.target.value })}
        />
      </Field>

      <Field
        label="Content"
        htmlFor={`${settingKey}_content`}
        hint="Supports Markdown-style # headings and line breaks."
      >
        <Textarea
          id={`${settingKey}_content`}
          rows={20}
          className="font-mono text-sm"
          value={form.text_value}
          onChange={(e) => setForm({ ...form, text_value: e.target.value })}
          placeholder="# Title\n\n## Section\n\nContent here..."
        />
      </Field>

      <div className="flex gap-3">
        <Button onClick={saveDraft} disabled={busy}>
          {busy ? 'Saving…' : setting ? 'Save Draft' : 'Create Draft'}
        </Button>
        {setting?.is_active && (
          <Button onClick={createNewVersion} disabled={busy}>
            Create New Version
          </Button>
        )}
      </div>
    </div>
  )
}
