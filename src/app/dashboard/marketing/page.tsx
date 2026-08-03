import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Mail, Megaphone, Star, TrendingUp } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { requestNow } from '@/lib/time'
import { isLive } from '@/lib/announcements'
import { TestimonialModeration } from '@/components/shared/TestimonialModeration'
import { AdminAnnouncementSettings } from '@/components/shared/AdminAnnouncementSettings'
import {
  ActionTile,
  EmptyState,
  HowItWorks,
  PageHeader,
  Panel,
  StatTile,
} from '@/components/ui/dashboard'
import { ButtonLink } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isManager } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The four things this screen holds, and the filter across the top.
 *
 * "All" is the landing state and stacks every section; the others narrow to one.
 * The counts beside each label are the rows the section is about to render, so a
 * tab that says (0) is a tab you already know is empty before opening it. There
 * is no hardcoded number here — every count below comes from a query.
 */
const TABS = [
  { key: 'all', label: 'All' },
  { key: 'newsletters', label: 'Newsletters' },
  { key: 'announcements', label: 'Announcements' },
  { key: 'reviews', label: 'Reviews' },
] as const

type TabKey = (typeof TABS)[number]['key']

interface Props {
  searchParams: Promise<{ tab?: string }>
}

/** Who a past send went to, in the words the composer uses. */
const AUDIENCE_LABELS: Record<string, string> = {
  clients: 'Clients',
  subscribers: 'Subscribers',
  staff: 'Staff',
}

/** The composer holds ten; more than that and the heading says so. */
const HISTORY_LIMIT = 10
/** Live reviews are shown in the order the home page shows them. */
const LIVE_REVIEW_LIMIT = 20

export default async function MarketingPage({ searchParams }: Props) {
  const { tab: tabParam } = await searchParams
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'all'

  const supabase = await createClient()

  // Same check as the section layout, repeated here on purpose: a layout does
  // not re-render on a client-side transition, so the tab bar can land someone
  // on this page without the layout's gate running again. Broadcast and
  // Newsletter already self-gate; this is the last page in the section that did
  // not.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/marketing')

  const { data: viewer } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!viewer || !isManager(viewer.role)) redirect('/dashboard')

  const [
    { data: pending },
    { data: liveReviews },
    { count: liveReviewCount },
    { count: subscribers },
    { data: announcements },
    { data: stats },
    { data: broadcasts },
    { count: broadcastCount },
  ] = await Promise.all([
    supabase
      .from('testimonials')
      .select('id, client_name, service_name, rating, body, created_at')
      .eq('is_approved', false)
      .order('created_at', { ascending: false }),
    supabase
      .from('testimonials')
      .select('id, client_name, service_name, rating, body, created_at')
      .eq('is_approved', true)
      .order('sort_order')
      .limit(LIVE_REVIEW_LIMIT),
    // Counted separately from the list above, which stops at twenty: a studio
    // with thirty published reviews should not be told it has twenty.
    supabase
      .from('testimonials')
      .select('id', { count: 'exact', head: true })
      .eq('is_approved', true),
    supabase
      .from('newsletter_subscribers')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false }),
    // Views, clicks and dismissals per announcement, so a promotion that
    // worked is distinguishable from one nobody saw.
    supabase.rpc('announcement_stats'),
    supabase
      .from('broadcasts')
      .select('id, subject, audience, recipient_count, unreachable_count, created_at')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
    supabase.from('broadcasts').select('id', { count: 'exact', head: true }),
  ])

  const pendingReviews = pending ?? []
  const allAnnouncements = announcements ?? []
  const history = broadcasts ?? []
  const sentCount = broadcastCount ?? 0
  const publishedCount = liveReviewCount ?? 0
  const reviewCount = pendingReviews.length + publishedCount

  // "Showing now" means what a visitor would actually meet: active, and inside
  // its scheduled window. `isLive` is the same predicate the public site filters
  // with, so this tile cannot claim a banner the site has already stopped
  // showing. Targeting is deliberately not applied — an announcement aimed at
  // signed-out visitors is still live, just not for everyone.
  const now = new Date(requestNow())
  const showingNow = allAnnouncements.filter((a) => isLive(a, now)).length

  const counts: Record<TabKey, number> = {
    all: sentCount + allAnnouncements.length + reviewCount,
    newsletters: sentCount,
    announcements: allAnnouncements.length,
    reviews: reviewCount,
  }

  const shows = (key: Exclude<TabKey, 'all'>) => tab === 'all' || tab === key

  return (
    <div>
      <PageHeader
        title="Marketing"
        lede="What goes out to the list, what sits on the site, and what clients have said about it."
      />

      {/* The three things a manager comes here to start. Each points at a real
          destination: the composer, this page's own announcements tab, and the
          section's analytics. */}
      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <ActionTile
          icon={Mail}
          title="Write a newsletter"
          subtitle={`Free to send · ${subscribers ?? 0} on the list`}
          href="/dashboard/marketing/broadcast"
        />
        <ActionTile
          icon={Megaphone}
          title="Post an announcement"
          subtitle={
            showingNow > 0
              ? `${showingNow} showing on the site now`
              : 'Nothing showing on the site now'
          }
          href="/dashboard/marketing?tab=announcements"
        />
        <ActionTile
          icon={TrendingUp}
          title="See what worked"
          subtitle="Traffic, the booking funnel and what it earned"
          href="/dashboard/marketing/analytics"
        />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* A count of people opens the people, not the composer. Both this tile
            and that list read `newsletter_subscribers`, so the number a manager
            clicks is the number they land on. */}
        <Link
          href="/dashboard/clients/newsletter"
          className="block transition-opacity hover:opacity-80"
        >
          <StatTile
            label="Newsletter list"
            value={String(subscribers ?? 0)}
            hint="Who is subscribed"
          />
        </Link>
        <StatTile label="Newsletters sent" value={String(sentCount)} />
        <StatTile
          label="Reviews awaiting"
          value={String(pendingReviews.length)}
          hint={pendingReviews.length > 0 ? 'Hidden until published' : undefined}
        />
        <StatTile
          label="Live reviews"
          value={String(publishedCount)}
          hint="Showing on the home page"
        />
      </div>

      <nav
        aria-label="Marketing sections"
        className="mt-10 flex flex-wrap gap-x-7 border-b border-[var(--color-border)]"
      >
        {TABS.map((t) => {
          const active = t.key === tab
          return (
            <Link
              key={t.key}
              href={t.key === 'all' ? '/dashboard/marketing' : `/dashboard/marketing?tab=${t.key}`}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'label-caps -mb-px flex min-h-11 items-center gap-1.5 border-b-2 transition-colors',
                active
                  ? 'border-[var(--color-foreground)]'
                  : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
              )}
            >
              {t.label}
              <span className="tabular-nums">({counts[t.key]})</span>
            </Link>
          )
        })}
      </nav>

      {shows('newsletters') && (
        <section className="mt-10">
          <h2 className="display text-2xl">Newsletters</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            {sentCount > HISTORY_LIMIT
              ? `The last ${HISTORY_LIMIT} of ${sentCount} sent.`
              : 'Everything sent to the list, newest first.'}
          </p>

          {history.length === 0 ? (
            <EmptyState
              className="mt-6"
              icon={Mail}
              title="No newsletters sent yet"
              description="Writing one delivers it to everyone on the list who has an account here, straight into their messages, and their replies come back as an ordinary conversation. Anyone without an account is listed at the end so you can email them by hand. The composer tells you how many that is and asks you to confirm before anything goes."
              action={
                <ButtonLink href="/dashboard/marketing/broadcast">Write a newsletter</ButtonLink>
              }
            />
          ) : (
            <>
              <Panel className="mt-6 divide-y divide-[var(--color-border)]">
                {history.map((b) => (
                  <div
                    key={b.id}
                    className="flex flex-wrap items-baseline justify-between gap-4 p-5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm">{b.subject}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        {new Date(b.created_at).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                        {' · '}
                        {AUDIENCE_LABELS[b.audience] ?? b.audience}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-[var(--color-muted)]">
                      {b.recipient_count} in app
                      {b.unreachable_count > 0 && ` · ${b.unreachable_count} needed email`}
                    </span>
                  </div>
                ))}
              </Panel>

              <div className="mt-5">
                <ButtonLink href="/dashboard/marketing/broadcast" variant="subtle" size="sm">
                  Write another
                </ButtonLink>
              </div>
            </>
          )}
        </section>
      )}

      {shows('announcements') && (
        <section className="mt-14">
          <h2 className="display text-2xl">Announcements</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            The bar above the site header, and the modal, corner card and inline note that share
            its settings. Only the highest-priority live one shows in each format.
          </p>

          <div className="mt-6">
            <AdminAnnouncementSettings announcements={allAnnouncements} stats={stats ?? []} />
          </div>
        </section>
      )}

      {shows('reviews') && (
        <section className="mt-14">
          <h2 className="display text-2xl">Reviews</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Client-submitted reviews stay hidden until someone approves them.
          </p>

          {reviewCount === 0 ? (
            <EmptyState
              className="mt-6"
              icon={Star}
              title="No reviews yet"
              description="Clients write these from the site. Anything submitted lands here first and stays hidden until someone publishes it, so nothing reaches the home page without a decision from the studio."
            />
          ) : (
            <>
              <h3 className="label-caps mt-8 text-[var(--color-accent)]">
                Awaiting approval ({pendingReviews.length})
              </h3>
              {pendingReviews.length === 0 ? (
                <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing waiting.</p>
              ) : (
                <ul className="mt-4 grid gap-4 xl:grid-cols-2">
                  {pendingReviews.map((t) => (
                    <li key={t.id}>
                      <TestimonialModeration testimonial={t} />
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="label-caps mt-10 text-[var(--color-accent)]">
                Live on the site ({publishedCount})
              </h3>
              {publishedCount === 0 ? (
                <p className="mt-4 text-sm text-[var(--color-muted)]">
                  Nothing published yet.
                </p>
              ) : (
                <>
                  <Panel className="mt-4 divide-y divide-[var(--color-border)]">
                    {(liveReviews ?? []).map((t) => (
                      <div key={t.id} className="p-5">
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                          <p className="label-caps text-[var(--color-muted)]">
                            {t.client_name}
                            {t.service_name && ` · ${t.service_name}`}
                          </p>
                          {t.rating && (
                            <span
                              className="flex gap-0.5"
                              aria-label={`${t.rating} out of 5`}
                            >
                              {Array.from({ length: t.rating }).map((_, i) => (
                                <Star
                                  key={i}
                                  className="h-3 w-3 fill-[var(--color-accent)] text-[var(--color-accent)]"
                                  aria-hidden
                                />
                              ))}
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
                          {t.body}
                        </p>
                      </div>
                    ))}
                  </Panel>
                  {publishedCount > LIVE_REVIEW_LIMIT && (
                    <p className="mt-3 text-xs text-[var(--color-muted)]">
                      The first {LIVE_REVIEW_LIMIT}, in the order the home page shows them.
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </section>
      )}

      <HowItWorks
        className="mt-16"
        items={[
          {
            icon: Mail,
            title: 'Newsletters arrive in the inbox here',
            body: 'Everyone on the list with an account gets it in their own messages, and a reply comes back as an ordinary conversation. The rest are listed so you can email them by hand.',
          },
          {
            icon: Megaphone,
            title: 'Announcements sit on the site',
            body: 'A banner, a modal, a corner card or an inline note — aimed at whoever you choose, on only the pages you name. Views and clicks are counted per announcement.',
          },
          {
            icon: Star,
            title: 'Reviews wait for a decision',
            body: 'A submitted review is invisible until it is published here. Published ones appear on the home page; removing one deletes it.',
          },
        ]}
      />
    </div>
  )
}
