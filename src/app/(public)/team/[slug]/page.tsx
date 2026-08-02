import Link from 'next/link'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { MapPin } from 'lucide-react'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { TeamMemberSocials } from '@/components/shared/TeamMemberSocials'
import { loadStaffLocations, type StaffProfile } from '@/types/team'

export const revalidate = 300

interface Props {
  params: Promise<{ slug: string }>
}

/**
 * One string literal, and only public columns — the same discipline as the
 * shop page, where `cost_cents` sits on the row and must never reach a
 * visitor. Here the equivalent columns are not on the row at all: licensure and
 * personnel records are separate tables `anon` cannot touch.
 */
const PUBLIC_COLUMNS =
  'profile_id, slug, display_name, headline, bio, pronouns, photo_url, specialities, certifications, languages, years_experience, instagram_url, tiktok_url, website_url'

type PublicMember = Pick<
  StaffProfile,
  | 'profile_id'
  | 'slug'
  | 'display_name'
  | 'headline'
  | 'bio'
  | 'pronouns'
  | 'photo_url'
  | 'specialities'
  | 'certifications'
  | 'languages'
  | 'years_experience'
  | 'instagram_url'
  | 'tiktok_url'
  | 'website_url'
>

/** Prerender everyone who is published. Same pattern as the service pages. */
export async function generateStaticParams() {
  try {
    const supabase = createPublicClient()
    const { data } = await supabase
      .from('staff_profiles')
      .select('slug')
      .eq('is_public', true)
    return (data ?? []).map((m) => ({ slug: m.slug }))
  } catch {
    return []
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('staff_profiles')
    .select('display_name, headline, bio')
    .eq('slug', slug)
    .eq('is_public', true)
    .maybeSingle()

  if (!data) return { title: 'The Team' }
  return {
    title: data.display_name,
    description: data.headline ?? data.bio?.slice(0, 155) ?? undefined,
  }
}

export default async function TeamMemberPage({ params }: Props) {
  const { slug } = await params
  const supabase = createPublicClient()

  const { data } = await supabase
    .from('staff_profiles')
    .select(PUBLIC_COLUMNS)
    .eq('slug', slug)
    .eq('is_public', true)
    .maybeSingle()

  // Unpublished, suspended or no longer staff all land here. The RLS policy
  // makes them indistinguishable from a slug that never existed, which is the
  // right answer for someone who has taken themselves off the site.
  if (!data) notFound()
  const member = data as PublicMember

  const locationMap = await loadStaffLocations(supabase, [member.profile_id])
  const locations = locationMap.get(member.profile_id) ?? []

  const facts: { label: string; value: string }[] = [
    member.years_experience != null && {
      label: 'Experience',
      value: `${member.years_experience} year${member.years_experience === 1 ? '' : 's'}`,
    },
    member.languages.length > 0 && {
      label: 'Languages',
      value: member.languages.join(', '),
    },
  ].filter(Boolean) as { label: string; value: string }[]

  return (
    <Section>
      <Container className="grid gap-16 lg:grid-cols-[1fr_1.2fr]">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Link
            href="/team"
            className="label-caps -my-2 inline-flex min-h-11 items-center py-2 text-[var(--color-muted)]"
          >
            ← The team
          </Link>

          <div className="relative mt-6 aspect-[4/5] w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
            {member.photo_url ? (
              <Image
                src={member.photo_url}
                alt={`${member.display_name}, ${member.headline ?? 'licensed esthetician'}`}
                fill
                priority
                sizes="(max-width: 1024px) 100vw, 40vw"
                className="object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <span className="display text-6xl text-[var(--color-muted)]">
                  {member.display_name
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join('')
                    .toUpperCase()}
                </span>
              </div>
            )}
          </div>

          <TeamMemberSocials
            instagram={member.instagram_url}
            tiktok={member.tiktok_url}
            website={member.website_url}
            className="mt-6"
          />
        </div>

        <div>
          <h1 className="display text-4xl sm:text-5xl">{member.display_name}</h1>

          {member.pronouns && (
            <p className="mt-2 text-[var(--color-muted)]">{member.pronouns}</p>
          )}

          {member.headline && (
            <p className="label-caps mt-5 text-[var(--color-accent)]">{member.headline}</p>
          )}

          {member.bio && (
            <p className="mt-8 whitespace-pre-line text-lg leading-relaxed text-[var(--color-muted)]">
              {member.bio}
            </p>
          )}

          {member.specialities.length > 0 && (
            <div className="mt-12 border-t border-[var(--color-border)] pt-10">
              <h2 className="label-caps mb-6 text-[var(--color-accent)]">Specialises in</h2>
              <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {member.specialities.map((s) => (
                  <li key={s} className="py-3.5 text-base">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {member.certifications.length > 0 && (
            <div className="mt-12 border-t border-[var(--color-border)] pt-10">
              <h2 className="label-caps mb-6 text-[var(--color-accent)]">Training</h2>
              <ul className="space-y-3">
                {member.certifications.map((c) => (
                  <li key={c} className="text-base leading-relaxed text-[var(--color-muted)]">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(facts.length > 0 || locations.length > 0) && (
            <dl className="mt-12 grid gap-8 border-t border-[var(--color-border)] pt-10 sm:grid-cols-2">
              {facts.map((f) => (
                <div key={f.label}>
                  <dt className="label-caps text-[var(--color-muted)]">{f.label}</dt>
                  <dd className="mt-2 text-base">{f.value}</dd>
                </div>
              ))}
              {locations.length > 0 && (
                <div>
                  <dt className="label-caps text-[var(--color-muted)]">
                    {locations.length === 1 ? 'Works at' : 'Works across'}
                  </dt>
                  <dd className="mt-2 space-y-1.5">
                    {locations.map((l) => (
                      <span key={l.id} className="flex items-center gap-2 text-base">
                        <MapPin
                          className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
                          strokeWidth={1.5}
                        />
                        {l.name}
                        {l.city && (
                          <span className="text-[var(--color-muted)]">· {l.city}</span>
                        )}
                      </span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          )}

          <div className="mt-14 border-t border-[var(--color-border)] pt-10">
            <ButtonLink href={`/book?provider=${member.slug}`} size="lg">
              Book with {member.display_name.split(/\s+/)[0]}
            </ButtonLink>
            <p className="mt-6 max-w-xl text-sm leading-relaxed text-[var(--color-muted)]">
              You are welcome to ask about training, scope, or anything else before you
              book — and to narrow the scope of a treatment or stop it at any point,
              without giving a reason.
            </p>
          </div>
        </div>
      </Container>
    </Section>
  )
}
