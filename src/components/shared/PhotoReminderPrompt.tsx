'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Camera, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input } from '@/components/ui/field'
import type { AppointmentPhotoPrompt, PhotoPhase } from '@/types/clientprofile'

const PHASE_LABEL: Record<PhotoPhase, string> = {
  before: 'Before photo',
  after: 'After photo',
  progress: 'Progress photo',
}

const PHASE_WHEN: Record<PhotoPhase, string> = {
  before: 'due at check-in',
  after: 'due before she leaves',
  progress: 'due at the follow-up',
}

/**
 * The prompt: a photograph is due on this visit.
 *
 * It renders nothing at all unless the view says one is due, and the view says
 * nothing is due unless consent permits the photograph — the blanket release on
 * the client record, plus, for an intimate service, the separate written
 * consent §6 requires. The gate lives in `client_photo_consent_ok`, not here,
 * so a second surface built later cannot forget it.
 *
 * What it says when consent is missing is the other half of the job: staff are
 * told the documentation is off and why, and are not given a capture button to
 * press anyway.
 */
export function PhotoReminderPrompt({
  prompt,
  compact = false,
}: {
  prompt: AppointmentPhotoPrompt
  compact?: boolean
}) {
  if (!prompt.photo_documented) return null

  if (!prompt.consent_ok) {
    return (
      <div className="border-l-2 border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="label-caps mb-2 text-[var(--color-muted)]">Not photographing this one</p>
        <p className="text-sm text-[var(--color-muted)]">
          {prompt.documented_services} is normally documented, but{' '}
          {prompt.intimate
            ? 'this is an intimate service and there is no separate photography consent on file. Ask at the appointment if she wants to sign one; either answer is fine.'
            : 'there is no photo release on file, or it has been withdrawn. She can turn it on herself under Account → Settings.'}
        </p>
      </div>
    )
  }

  if (!prompt.photo_due) {
    const taken = prompt.before_count + prompt.after_count + prompt.progress_count
    if (taken === 0) return null
    return compact ? null : (
      <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
        {taken} {taken === 1 ? 'photo' : 'photos'} on file for this visit.
      </p>
    )
  }

  const due = prompt.photo_due

  return (
    <div className="border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 dark:bg-transparent">
      <div className="flex flex-wrap items-center gap-2">
        <p className="label-caps flex items-center gap-2 text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
          <Camera className="h-3.5 w-3.5" strokeWidth={2} />
          {PHASE_LABEL[due]} {PHASE_WHEN[due]}
        </p>
        {prompt.intimate && <Badge tone="info">Separate consent signed</Badge>}
      </div>

      <p className="mt-2 text-sm text-[var(--color-muted)]">
        {prompt.documented_services} is a series — the difference is not visible in a
        mirror six weeks apart.
        {prompt.intimate &&
          ' Drape everything but the area being treated, and stop the moment she asks.'}
      </p>

      <div className="mt-4">
        <PhotoCapture
          clientId={prompt.client_id}
          appointmentId={prompt.appointment_id}
          phase={due}
          intimate={prompt.intimate}
        />
      </div>
    </div>
  )
}

/**
 * Take the photograph.
 *
 * Uploads straight into the private `treatment` bucket under
 * `<client_uuid>/<appointment_uuid>/<file>` — the path shape 011's storage
 * policies authorise against — and writes the row. `consent_given` is a CHECK
 * constraint on `treatment_photos`, not a convention, so the tick below is not
 * a formality: without it the insert is rejected by the database.
 */
function PhotoCapture({
  clientId,
  appointmentId,
  phase,
  intimate,
}: {
  clientId: string
  appointmentId: string
  phase: PhotoPhase
  intimate: boolean
}) {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [bodyArea, setBodyArea] = useState('')
  const [busy, setBusy] = useState(false)

  async function upload(file: File) {
    setBusy(true)
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setBusy(false)
      toast.error('Please sign in again.')
      return
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const path = `${clientId}/${appointmentId}/${phase}-${crypto.randomUUID()}.${ext}`

    const { error: uploadError } = await supabase.storage
      .from('treatment')
      .upload(path, file, { contentType: file.type, upsert: false })

    if (uploadError) {
      setBusy(false)
      toast.error(uploadError.message || 'Could not upload that.')
      return
    }

    const { error } = await supabase.from('treatment_photos').insert({
      client_id: clientId,
      appointment_id: appointmentId,
      storage_path: path,
      phase,
      body_area: bodyArea.trim() || null,
      // taken_by must equal auth.uid() — the insert policy enforces it.
      taken_by: user.id,
      consent_given: true,
      // Marketing is a separate, narrower permission and is never granted here.
      marketing_consent: false,
    })

    setBusy(false)

    if (error) {
      // The object is orphaned rather than left masquerading as a consented
      // photograph. A row is what makes an image part of the record.
      await supabase.storage.from('treatment').remove([path])
      toast.error(error.message || 'Could not save the photo.')
      return
    }

    setBodyArea('')
    setConfirmed(false)
    toast.success(`${PHASE_LABEL[phase]} saved.`)
    router.refresh()
  }

  return (
    <div className="space-y-3">
      <Field
        label="Area"
        htmlFor={`area_${appointmentId}_${phase}`}
        hint={intimate ? 'Required. Exactly the area she agreed to, and nothing else in frame.' : 'Optional — e.g. left cheek, underarms.'}
      >
        <Input
          id={`area_${appointmentId}_${phase}`}
          maxLength={120}
          value={bodyArea}
          onChange={(e) => setBodyArea(e.target.value)}
        />
      </Field>

      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          She said yes to this photograph, just now
          <span className="block text-xs text-[var(--color-muted)]">
            Per-image consent, separate from the release on her record. She can ask
            for it to be deleted straight afterwards.
          </span>
        </span>
      </label>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void upload(f)
        }}
      />

      <Button
        type="button"
        size="sm"
        disabled={busy || !confirmed || (intimate && !bodyArea.trim())}
        onClick={() => fileRef.current?.click()}
      >
        <Camera className="h-4 w-4" strokeWidth={1.5} />
        {busy ? 'Saving…' : `Take the ${phase} photo`}
      </Button>
    </div>
  )
}
