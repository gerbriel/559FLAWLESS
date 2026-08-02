import { Globe } from 'lucide-react'

/**
 * Lucide v1 dropped brand marks, so these are inlined — the same reasoning, and
 * the same Instagram glyph, as SiteFooter.
 */
function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M15 3v10.5a4.5 4.5 0 1 1-4.5-4.5" />
      <path d="M15 6.5A4.5 4.5 0 0 0 19.5 11" />
    </svg>
  )
}

/**
 * A team member's own links.
 *
 * `rel="nofollow"` as well as noopener: these point off the studio's site to
 * accounts the studio does not control, and an editable link field on a public
 * page is otherwise a standing invitation to pass along ranking.
 */
export function TeamMemberSocials({
  instagram,
  tiktok,
  website,
  className,
}: {
  instagram: string | null
  tiktok: string | null
  website: string | null
  className?: string
}) {
  const links = [
    instagram && { href: instagram, label: 'Instagram', Icon: InstagramIcon },
    tiktok && { href: tiktok, label: 'TikTok', Icon: TikTokIcon },
    website && { href: website, label: 'Website', Icon: Globe },
  ].filter(Boolean) as {
    href: string
    label: string
    Icon: (props: { className?: string }) => React.ReactElement
  }[]

  if (links.length === 0) return null

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-6">
        {links.map(({ href, label, Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="label-caps inline-flex min-h-11 items-center gap-2 text-[var(--color-muted)] transition-colors hover:text-[var(--color-accent)]"
          >
            <Icon className="h-4 w-4" />
            {label}
          </a>
        ))}
      </div>
    </div>
  )
}
