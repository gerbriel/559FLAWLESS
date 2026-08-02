import Link from 'next/link'
import Image from 'next/image'
import type { StaffProfile, TeamLocation } from '@/types/team'

type CardMember = Pick<
  StaffProfile,
  'profile_id' | 'slug' | 'display_name' | 'headline' | 'pronouns' | 'photo_url' | 'specialities'
>

/**
 * One person on /team.
 *
 * Portrait first and full-bleed within its frame, name in the serif display
 * face, everything else quiet — the same editorial rhythm as the service menu.
 * The whole card is one link: a card with a photo, a name and a separate
 * "read more" is three tap targets doing one job.
 */
export function TeamMemberCard({
  member,
  locations = [],
}: {
  member: CardMember
  locations?: TeamLocation[]
}) {
  const specialities = member.specialities.slice(0, 3)

  return (
    <Link
      href={`/team/${member.slug}`}
      className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
        {member.photo_url ? (
          <Image
            src={member.photo_url}
            alt={`${member.display_name}, ${member.headline ?? 'licensed esthetician'}`}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-cover transition-transform duration-700 group-hover:scale-[1.03]"
          />
        ) : (
          // No photograph is a perfectly ordinary state — someone may have
          // published a profile and not sent one, or may not want their face on
          // a website at all. It should look considered, not broken.
          <div className="flex h-full w-full items-center justify-center">
            <span className="display text-5xl text-[var(--color-muted)]">
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

      <h2 className="display mt-6 text-2xl transition-colors group-hover:text-[var(--color-accent)]">
        {member.display_name}
      </h2>

      {member.pronouns && (
        <p className="mt-1 text-sm text-[var(--color-muted)]">{member.pronouns}</p>
      )}

      {member.headline && (
        <p className="label-caps mt-3 text-[var(--color-accent)]">{member.headline}</p>
      )}

      {specialities.length > 0 && (
        <p className="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">
          {specialities.join(' · ')}
        </p>
      )}

      {locations.length > 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          {locations.map((l) => l.name).join(', ')}
        </p>
      )}
    </Link>
  )
}
