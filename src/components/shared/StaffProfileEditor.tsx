'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { toast } from 'sonner'
import { Eye, EyeOff, Upload, ExternalLink } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import type { StaffProfile, TeamLocation } from '@/types/team'

/** One item per line. Blank lines and stray whitespace are the user's, not ours. */
function toList(text: string, max: number): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, max)
}

const fromList = (list: string[]) => list.join('\n')

/**
 * The half of a team member's record that they own.
 *
 * Everything on this form is public the moment "Show me on the website" is on,
 * and nothing on it is anything but. Licensure and the personnel record live in
 * their own tables with their own policies — see StaffProfileInternal, and the
 * header of migration 041 for why the split is physical rather than a matter of
 * which columns this component remembers to send.
 *
 * A manager can open anyone's; everyone else gets exactly their own, which is
 * also what the database will allow.
 */
export function StaffProfileEditor({
  profile,
  isSelf,
  isManager,
  locations = [],
}: {
  profile: StaffProfile
  isSelf: boolean
  isManager: boolean
  locations?: TeamLocation[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)

  const [isPublic, setIsPublic] = useState(profile.is_public)
  const [displayName, setDisplayName] = useState(profile.display_name)
  const [slug, setSlug] = useState(profile.slug)
  const [headline, setHeadline] = useState(profile.headline ?? '')
  const [pronouns, setPronouns] = useState(profile.pronouns ?? '')
  const [bio, setBio] = useState(profile.bio ?? '')
  const [photoUrl, setPhotoUrl] = useState(profile.photo_url)
  const [specialities, setSpecialities] = useState(fromList(profile.specialities))
  const [certifications, setCertifications] = useState(fromList(profile.certifications))
  const [languages, setLanguages] = useState(fromList(profile.languages))
  const [years, setYears] = useState(
    profile.years_experience == null ? '' : String(profile.years_experience)
  )
  const [instagram, setInstagram] = useState(profile.instagram_url ?? '')
  const [tiktok, setTiktok] = useState(profile.tiktok_url ?? '')
  const [website, setWebsite] = useState(profile.website_url ?? '')
  const [sortOrder, setSortOrder] = useState(String(profile.sort_order))

  const id = profile.profile_id.slice(0, 8)

  async function uploadPhoto(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      toast.error('That image is over 10 MB. The bucket will refuse it.')
      return
    }

    const supabase = createClient()
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    // site/team/<profile uuid>/<file>. The uuid segment is the authorisation:
    // migration 041 checks it against auth.uid(), the same way the treatment
    // bucket checks its first segment. A random filename means replacing a
    // photo never has to fight a CDN cache.
    const path = `team/${profile.profile_id}/${crypto.randomUUID()}.${ext}`

    setUploading(true)
    const { error } = await supabase.storage.from('site').upload(path, file, {
      cacheControl: '31536000',
      contentType: file.type,
    })
    if (error) {
      setUploading(false)
      toast.error(error.message || 'Could not upload that photograph.')
      return
    }

    const { data } = supabase.storage.from('site').getPublicUrl(path)
    const { error: saveError } = await supabase
      .from('staff_profiles')
      .update({ photo_url: data.publicUrl })
      .eq('profile_id', profile.profile_id)
    setUploading(false)

    if (saveError) {
      toast.error('Uploaded, but could not attach it to the profile.')
      return
    }

    setPhotoUrl(data.publicUrl)
    toast.success('Photograph updated.')
    router.refresh()
  }

  async function removePhoto() {
    setBusy(true)
    const { error } = await createClient()
      .from('staff_profiles')
      .update({ photo_url: null })
      .eq('profile_id', profile.profile_id)
    setBusy(false)
    if (error) {
      toast.error('Could not remove that photograph.')
      return
    }
    setPhotoUrl(null)
    toast.success('Photograph removed.')
    router.refresh()
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const name = displayName.trim()
    if (!name) {
      toast.error('A profile needs a name to show.')
      return
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 60) {
      toast.error('The web address may only contain lower-case letters, numbers and hyphens.')
      return
    }

    const trimmedYears = years.trim()
    let yearsValue: number | null = null
    if (trimmedYears !== '') {
      const n = Number(trimmedYears)
      if (!Number.isInteger(n) || n < 0 || n > 70) {
        toast.error('Years of experience must be a whole number between 0 and 70.')
        return
      }
      yearsValue = n
    }

    for (const [label, value] of [
      ['Instagram', instagram],
      ['TikTok', tiktok],
      ['website', website],
    ] as const) {
      if (value.trim() && !value.trim().startsWith('https://')) {
        toast.error(`The ${label} link must start with https://`)
        return
      }
    }

    setBusy(true)
    const { error } = await createClient()
      .from('staff_profiles')
      .update({
        is_public: isPublic,
        display_name: name,
        slug,
        headline: headline.trim() || null,
        pronouns: pronouns.trim() || null,
        bio: bio.trim() || null,
        specialities: toList(specialities, 12),
        certifications: toList(certifications, 12),
        languages: toList(languages, 8),
        years_experience: yearsValue,
        instagram_url: instagram.trim() || null,
        tiktok_url: tiktok.trim() || null,
        website_url: website.trim() || null,
        ...(isManager ? { sort_order: Number(sortOrder) || 0 } : {}),
      })
      .eq('profile_id', profile.profile_id)
    setBusy(false)

    if (error) {
      // A unique violation on slug is the one a user can act on.
      toast.error(
        error.code === '23505'
          ? 'That web address is already taken by someone else on the team.'
          : error.message || 'Could not save.'
      )
      return
    }

    toast.success('Saved.')
    router.refresh()
  }

  return (
    <form onSubmit={save} className="space-y-8">
      <div className="flex flex-wrap items-center gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <label className="flex flex-1 cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Show me on the website
            <span className="block text-xs text-[var(--color-muted)]">
              Publishes this page at /team/{slug || '…'}. Untick it and you disappear from
              the site immediately — no one else has to approve that.
            </span>
          </span>
        </label>
        <Badge tone={isPublic ? 'success' : 'neutral'}>
          {isPublic ? (
            <>
              <Eye className="h-3 w-3" strokeWidth={1.5} /> Live
            </>
          ) : (
            <>
              <EyeOff className="h-3 w-3" strokeWidth={1.5} /> Not shown
            </>
          )}
        </Badge>
        {isPublic && (
          <a
            href={`/team/${profile.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="label-caps inline-flex min-h-11 items-center gap-1.5 text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            View <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
          </a>
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Name as shown"
          htmlFor={`sp_name_${id}`}
          hint="What a client reads. Not necessarily your legal name."
        >
          <Input
            id={`sp_name_${id}`}
            maxLength={80}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>

        <Field
          label="Web address"
          htmlFor={`sp_slug_${id}`}
          hint={`559flawless.com/team/${slug || '…'} — changing it breaks the old link.`}
        >
          <Input
            id={`sp_slug_${id}`}
            maxLength={60}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Headline"
          htmlFor={`sp_headline_${id}`}
          hint="One line under your name, e.g. “Licensed esthetician · corrective skin”."
        >
          <Input
            id={`sp_headline_${id}`}
            maxLength={140}
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
          />
        </Field>

        <Field
          label="Pronouns"
          htmlFor={`sp_pronouns_${id}`}
          hint="Shown on your profile. Leave blank to show none."
        >
          <Input
            id={`sp_pronouns_${id}`}
            maxLength={40}
            placeholder="she/her"
            value={pronouns}
            onChange={(e) => setPronouns(e.target.value)}
          />
        </Field>
      </div>

      <Field
        label="Biography"
        htmlFor={`sp_bio_${id}`}
        hint="The long version, for your own page. The short blurb on the booking step is set in your account settings."
      >
        <Textarea
          id={`sp_bio_${id}`}
          rows={7}
          maxLength={4000}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
        />
      </Field>

      <fieldset className="space-y-5 border-t border-[var(--color-border)] pt-8">
        <legend className="label-caps mb-2 text-[var(--color-accent)]">Photograph</legend>

        <div className="flex flex-wrap items-start gap-6">
          <div className="relative h-40 w-32 shrink-0 overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-background)]">
            {photoUrl ? (
              <Image
                src={photoUrl}
                alt=""
                fill
                sizes="128px"
                className="object-cover"
                unoptimized
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-[var(--color-muted)]">
                None
              </div>
            )}
          </div>

          <div className="space-y-3">
            <label className="label-caps inline-flex min-h-11 cursor-pointer items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 hover:border-[var(--color-accent)]">
              <Upload className="h-4 w-4" strokeWidth={1.5} />
              {uploading ? 'Uploading…' : photoUrl ? 'Replace' : 'Upload'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif"
                className="sr-only"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void uploadPhoto(file)
                  e.target.value = ''
                }}
              />
            </label>

            {photoUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={removePhoto} disabled={busy}>
                Remove
              </Button>
            )}

            <p className="max-w-xs text-xs leading-relaxed text-[var(--color-muted)]">
              Portrait, roughly 4:5. It saves on upload rather than with the rest of the
              form, so you can see it before you commit to anything else.
            </p>
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-5 border-t border-[var(--color-border)] pt-8">
        <legend className="label-caps mb-2 text-[var(--color-accent)]">
          What you are known for
        </legend>

        <Field
          label="Specialities"
          htmlFor={`sp_spec_${id}`}
          hint="One per line, up to 12. These are what a client is choosing on."
        >
          <Textarea
            id={`sp_spec_${id}`}
            rows={4}
            placeholder={'Acne and congestion\nPigmentation\nBrazilian waxing'}
            value={specialities}
            onChange={(e) => setSpecialities(e.target.value)}
          />
        </Field>

        <Field
          label="Training and certifications"
          htmlFor={`sp_certs_${id}`}
          hint="One per line, up to 12. Course names and awarding bodies — not your licence number, which is recorded separately and is never public."
        >
          <Textarea
            id={`sp_certs_${id}`}
            rows={4}
            placeholder={'Rhonda Allison Advanced Peels\nDermaplaning certification'}
            value={certifications}
            onChange={(e) => setCertifications(e.target.value)}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Languages"
            htmlFor={`sp_langs_${id}`}
            hint="One per line, up to 8."
          >
            <Textarea
              id={`sp_langs_${id}`}
              rows={3}
              placeholder={'English\nSpanish'}
              value={languages}
              onChange={(e) => setLanguages(e.target.value)}
            />
          </Field>

          <Field
            label="Years of experience"
            htmlFor={`sp_years_${id}`}
            hint="Whole years. Leave blank to show nothing."
          >
            <Input
              id={`sp_years_${id}`}
              type="number"
              min={0}
              max={70}
              value={years}
              onChange={(e) => setYears(e.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-5 border-t border-[var(--color-border)] pt-8">
        <legend className="label-caps mb-2 text-[var(--color-accent)]">Links</legend>
        <p className="text-xs text-[var(--color-muted)]">
          https:// only — these render as links on a page anyone can open.
        </p>

        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Instagram" htmlFor={`sp_ig_${id}`}>
            <Input
              id={`sp_ig_${id}`}
              inputMode="url"
              maxLength={300}
              placeholder="https://instagram.com/…"
              value={instagram}
              onChange={(e) => setInstagram(e.target.value)}
            />
          </Field>
          <Field label="TikTok" htmlFor={`sp_tt_${id}`}>
            <Input
              id={`sp_tt_${id}`}
              inputMode="url"
              maxLength={300}
              placeholder="https://tiktok.com/@…"
              value={tiktok}
              onChange={(e) => setTiktok(e.target.value)}
            />
          </Field>
          <Field label="Website" htmlFor={`sp_web_${id}`}>
            <Input
              id={`sp_web_${id}`}
              inputMode="url"
              maxLength={300}
              placeholder="https://…"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </Field>
        </div>
      </fieldset>

      {locations.length > 0 && (
        <div className="border-t border-[var(--color-border)] pt-8">
          <p className="label-caps mb-3 text-[var(--color-accent)]">Works at</p>
          <div className="flex flex-wrap gap-2">
            {locations.map((l) => (
              <Badge key={l.id} tone="info">
                {l.name}
              </Badge>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Set under{' '}
            <Link
              href="/dashboard/settings/locations"
              className="underline underline-offset-4"
            >
              Locations
            </Link>
            . Shown on the public profile when the studio runs more than one.
          </p>
        </div>
      )}

      {isManager && (
        <div className="border-t border-[var(--color-border)] pt-8">
          <Field
            label="Order on the team page"
            htmlFor={`sp_sort_${id}`}
            hint="Lower first. Ties fall back to alphabetical."
            className="max-w-xs"
          >
            <Input
              id={`sp_sort_${id}`}
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </Field>
        </div>
      )}

      <div className="flex items-center gap-4">
        <Button type="submit" size="lg" disabled={busy || uploading}>
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
        {!isSelf && (
          <p className="text-xs text-[var(--color-muted)]">
            You are editing someone else&rsquo;s profile.
          </p>
        )}
      </div>
    </form>
  )
}
