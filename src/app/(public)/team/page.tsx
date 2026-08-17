import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { TeamMemberCard } from '@/components/shared/TeamMemberCard'
import { loadStaffLocations, type StaffProfile } from '@/types/team'

/**
 * Static, revalidated — like every other page under (public).
 *
 * `createPublicClient()` sends the anon key and nothing else. The cookie-reading
 * client from @supabase/ssr would opt this route, and the whole subtree with it,
 * into dynamic rendering for the sake of a session this page never consults.
 * The only rows it can see are the ones migration 041 lets `anon` see, which is
 * exactly the audience it is written for.
 */
export const revalidate = 300

export const metadata: Metadata = {
  title: 'The Team',
  description:
    'The Licensed Cosmetologists behind 559 Flawless in Fresno — what they specialise in, how they work, and how to book with them.',
}

export default async function TeamPage() {
  const supabase = createPublicClient()

  // One string literal. Concatenation widens the select to `string` and
  // collapses the result type to SelectQueryError.
  //
  // Every column named here is public by construction: licensure and personnel
  // records live in separate tables that `anon` holds no privilege on at all.
  // `is_public` is restated even though the RLS policy already requires it —
  // the filter that matters is in the database, but a reader of this file
  // should not have to go and look it up.
  const { data } = await supabase
    .from('staff_profiles')
    .select(
      'profile_id, slug, display_name, headline, bio, pronouns, photo_url, specialities, certifications, languages, years_experience, instagram_url, tiktok_url, website_url, sort_order'
    )
    .eq('is_public', true)
    .order('sort_order')
    .order('display_name')

  const team = (data ?? []) as Pick<
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
    | 'sort_order'
  >[]

  const locations = await loadStaffLocations(
    supabase,
    team.map((m) => m.profile_id)
  )

  // Worth naming only when there is more than one to tell apart.
  const showLocations = new Set([...locations.values()].flat().map((l) => l.id)).size > 1

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow="The team"
          title="Who you will be seeing."
          lede="One room, one client, and a Licensed Cosmetologist who has time to actually look at your skin. You can book with whoever you like — or ask for the same person every visit."
        />

        {team.length === 0 ? (
          <div className="mt-20 border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
            <p className="display text-2xl">Introductions are on their way.</p>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              In the meantime, every treatment is performed by a Licensed Cosmetologist —
              you are welcome to ask about training and scope before you book.
            </p>
          </div>
        ) : (
          <div className="mt-20 grid gap-x-10 gap-y-16 sm:grid-cols-2 lg:grid-cols-3">
            {team.map((member) => (
              <TeamMemberCard
                key={member.profile_id}
                member={member}
                locations={showLocations ? (locations.get(member.profile_id) ?? []) : []}
              />
            ))}
          </div>
        )}

        <p className="mt-24 max-w-2xl border-t border-[var(--color-border)] pt-10 text-sm leading-relaxed text-[var(--color-muted)]">
          Every service is performed within the scope of a current California cosmetology
          licence. Anything outside that scope is referred out rather than improvised, and
          you can ask to see credentials at any visit.
        </p>
      </Container>
    </Section>
  )
}
