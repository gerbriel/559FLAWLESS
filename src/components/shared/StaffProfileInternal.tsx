'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import {
  EMPLOYMENT_TYPE_LABELS,
  LICENCE_TYPE_LABELS,
  type EmploymentType,
  type LicenceType,
  type StaffCredential,
  type StaffEmployment,
} from '@/types/team'
import { StaffProfileLicenceBadge } from '@/components/shared/StaffProfileLicenceBadge'

/**
 * Licensure and the personnel record — the half a team member does not own.
 *
 * Rendered only for managers, but that is decoration: the policies in migration
 * 041 are what stop a provider reading her own employment row, and they hold
 * whether or not this component is on screen. It is the same arrangement as the
 * role helpers in src/types/database.ts — the UI copy hides a button, the SQL
 * copy refuses a request.
 *
 * The two halves are separate tables and are saved separately, so a failure to
 * write an HR note cannot silently discard a licence renewal.
 */
export function StaffProfileInternal({
  profileId,
  personName,
  credential,
  employment,
  now,
}: {
  profileId: string
  personName: string
  credential: StaffCredential | null
  employment: StaffEmployment | null
  /** requestNow() from the server. See StaffProfileLicenceBadge. */
  now: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const [licenceNumber, setLicenceNumber] = useState(credential?.licence_number ?? '')
  const [licenceType, setLicenceType] = useState<string>(credential?.licence_type ?? '')
  const [licenceState, setLicenceState] = useState(credential?.licence_state ?? 'CA')
  const [issuedOn, setIssuedOn] = useState(credential?.licence_issued_on ?? '')
  const [expiresOn, setExpiresOn] = useState(credential?.licence_expires_on ?? '')
  const [verified, setVerified] = useState(Boolean(credential?.verified_at))

  const [startedOn, setStartedOn] = useState(employment?.started_on ?? '')
  const [endedOn, setEndedOn] = useState(employment?.ended_on ?? '')
  const [employmentType, setEmploymentType] = useState<string>(employment?.employment_type ?? '')
  const [contactName, setContactName] = useState(employment?.emergency_contact_name ?? '')
  const [contactPhone, setContactPhone] = useState(employment?.emergency_contact_phone ?? '')
  const [contactRelation, setContactRelation] = useState(
    employment?.emergency_contact_relationship ?? ''
  )
  const [notes, setNotes] = useState(employment?.internal_notes ?? '')

  const id = profileId.slice(0, 8)

  async function saveCredentials(e: React.FormEvent) {
    e.preventDefault()

    if (issuedOn && expiresOn && expiresOn < issuedOn) {
      toast.error('A licence cannot expire before it was issued.')
      return
    }

    const supabase = createClient()
    setBusy(true)
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const { error } = await supabase.from('staff_credentials').upsert(
      {
        profile_id: profileId,
        licence_number: licenceNumber.trim() || null,
        licence_type: (licenceType || null) as LicenceType | null,
        licence_state: licenceState.trim().toUpperCase() || 'CA',
        licence_issued_on: issuedOn || null,
        licence_expires_on: expiresOn || null,
        // A date rather than a flag: "verified in 2019" and "verified last
        // week" are different facts about the same licence.
        verified_at: verified ? (credential?.verified_at ?? new Date().toISOString()) : null,
        verified_by: verified ? (user?.id ?? null) : null,
      },
      { onConflict: 'profile_id' }
    )
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not save that licence.')
      return
    }
    toast.success('Licence saved.')
    router.refresh()
  }

  async function saveEmployment(e: React.FormEvent) {
    e.preventDefault()

    if (startedOn && endedOn && endedOn < startedOn) {
      toast.error('An end date before a start date is not a date range.')
      return
    }

    const supabase = createClient()
    setBusy(true)
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const { error } = await supabase.from('staff_employment').upsert(
      {
        profile_id: profileId,
        started_on: startedOn || null,
        ended_on: endedOn || null,
        employment_type: (employmentType || null) as EmploymentType | null,
        emergency_contact_name: contactName.trim() || null,
        emergency_contact_phone: contactPhone.trim() || null,
        emergency_contact_relationship: contactRelation.trim() || null,
        internal_notes: notes.trim() || null,
        updated_by: user?.id ?? null,
      },
      { onConflict: 'profile_id' }
    )
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not save that record.')
      return
    }
    toast.success('Record saved.')
    router.refresh()
  }

  return (
    <div className="space-y-10 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-6 dark:bg-[var(--color-background)]">
      <p className="label-caps flex items-center gap-2 text-[var(--color-accent)]">
        <Lock className="h-3.5 w-3.5" strokeWidth={1.5} />
        Studio record — never public
      </p>

      <form onSubmit={saveCredentials} className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h4 className="display text-xl">Licence</h4>
          <StaffProfileLicenceBadge expiresOn={expiresOn || null} now={now} />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Licence number"
            htmlFor={`sc_num_${id}`}
            hint="Held for the studio's records. It is not on any public page."
          >
            <Input
              id={`sc_num_${id}`}
              maxLength={40}
              value={licenceNumber}
              onChange={(e) => setLicenceNumber(e.target.value)}
            />
          </Field>

          <Field label="Type" htmlFor={`sc_type_${id}`}>
            <Select
              id={`sc_type_${id}`}
              value={licenceType}
              onChange={(e) => setLicenceType(e.target.value)}
            >
              <option value="">Not recorded</option>
              {(Object.keys(LICENCE_TYPE_LABELS) as LicenceType[]).map((t) => (
                <option key={t} value={t}>
                  {LICENCE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="State" htmlFor={`sc_state_${id}`} hint="Two letters.">
            <Input
              id={`sc_state_${id}`}
              maxLength={2}
              value={licenceState}
              onChange={(e) => setLicenceState(e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Issued" htmlFor={`sc_issued_${id}`}>
            <Input
              id={`sc_issued_${id}`}
              type="date"
              value={issuedOn}
              onChange={(e) => setIssuedOn(e.target.value)}
            />
          </Field>
          <Field
            label="Expires"
            htmlFor={`sc_expires_${id}`}
            hint="Reminders go out at 60, 30, 14 and 7 days."
          >
            <Input
              id={`sc_expires_${id}`}
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Checked against the state board
            <span className="block text-xs text-[var(--color-muted)]">
              {credential?.verified_at
                ? `Last checked ${new Date(credential.verified_at).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}.`
                : 'Records who confirmed it and when.'}
            </span>
          </span>
        </label>

        <Button type="submit" size="sm" variant="subtle" disabled={busy}>
          {busy ? 'Saving…' : 'Save licence'}
        </Button>
      </form>

      <form onSubmit={saveEmployment} className="space-y-5 border-t border-[var(--color-border)] pt-8">
        <h4 className="display text-xl">Employment</h4>
        <p className="text-xs leading-relaxed text-[var(--color-muted)]">
          {personName} cannot see or edit any of this, on their own record or anyone
          else&rsquo;s. A personnel file the subject can rewrite is evidence of nothing.
        </p>

        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Started" htmlFor={`se_start_${id}`}>
            <Input
              id={`se_start_${id}`}
              type="date"
              value={startedOn}
              onChange={(e) => setStartedOn(e.target.value)}
            />
          </Field>
          <Field label="Ended" htmlFor={`se_end_${id}`} hint="Leave blank if current.">
            <Input
              id={`se_end_${id}`}
              type="date"
              value={endedOn}
              onChange={(e) => setEndedOn(e.target.value)}
            />
          </Field>
          <Field label="Arrangement" htmlFor={`se_type_${id}`}>
            <Select
              id={`se_type_${id}`}
              value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value)}
            >
              <option value="">Not recorded</option>
              {(Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[]).map((t) => (
                <option key={t} value={t}>
                  {EMPLOYMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <fieldset className="space-y-5">
          <legend className="label-caps mb-3 text-[var(--color-muted)]">
            In an emergency, call
          </legend>
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Name" htmlFor={`se_ec_name_${id}`}>
              <Input
                id={`se_ec_name_${id}`}
                maxLength={120}
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
              />
            </Field>
            <Field label="Phone" htmlFor={`se_ec_phone_${id}`}>
              <Input
                id={`se_ec_phone_${id}`}
                type="tel"
                maxLength={40}
                value={contactPhone}
                onChange={(e) => setContactPhone(e.target.value)}
              />
            </Field>
            <Field label="Relationship" htmlFor={`se_ec_rel_${id}`}>
              <Input
                id={`se_ec_rel_${id}`}
                maxLength={60}
                placeholder="Sister"
                value={contactRelation}
                onChange={(e) => setContactRelation(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>

        <Field
          label="Internal notes"
          htmlFor={`se_notes_${id}`}
          hint="Visible to managers and admins only."
        >
          <Textarea
            id={`se_notes_${id}`}
            rows={4}
            maxLength={8000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <Button type="submit" size="sm" variant="subtle" disabled={busy}>
          {busy ? 'Saving…' : 'Save record'}
        </Button>
      </form>
    </div>
  )
}
