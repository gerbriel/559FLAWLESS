import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BookingSettingsForm } from '@/components/shared/BookingSettingsForm'
import { SalesTaxForm } from '@/components/shared/SalesTaxForm'
import { ScheduledJobs } from '@/components/shared/ScheduledJobs'
import {
  StaffVisibility,
  type StaffVisibilityRow,
} from '@/components/shared/StaffVisibility'
import {
  BusinessHoursForm,
  type BusinessHourRow,
} from '@/components/shared/BusinessHoursForm'
import { dateKeyInTimeZone, requestNow } from '@/lib/time'
import {
  ROLE_LABELS,
  type UserRole,
  isAdmin,
  isFrontDesk,
  isManager,
  isStaff,
} from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * One row of the index. `visible` mirrors the gate the page itself enforces —
 * it hides a link, it authorises nothing. Get it wrong and the tab is an
 * ejector seat: most of these redirect to /dashboard, not back to here.
 */
interface SettingsLink {
  href: string
  label: string
  description: string
  visible: boolean
}

interface SettingsGroup {
  title: string
  links: SettingsLink[]
}

export default async function SettingsPage() {
  const supabase = await createClient()

  // The studio's own wall clock decides which closures are still ahead. A date
  // key derived from the server's zone would drop today's closure eight hours
  // early, or keep yesterday's around, depending on where the server sits.
  //
  // `is_active` is what makes this "the first open location", which is the claim
  // the Locations copy below makes and what `default_location_id()` (032) hands
  // every appointment, sale and stock count. Timesheets already filters the same
  // way. With every site deactivated — a misconfiguration, not a state to design
  // for — this falls through to the constant rather than reading a closed site.
  //
  // This has to land before the closures query can be written, because `todayKey`
  // is that query's lower bound and nothing else in the batch wants the zone. But
  // it needs nothing from the session, so it rides along with the auth call
  // instead of costing a sequential round trip of its own.
  const [
    {
      data: { user },
    },
    { data: studio },
  ] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from('locations')
      .select('timezone')
      .eq('is_active', true)
      .order('sort_order')
      .order('id')
      .limit(1)
      .maybeSingle(),
  ])

  if (!user) redirect('/login?next=/dashboard/settings')

  const timeZone = studio?.timezone ?? 'America/Los_Angeles'
  const todayKey = dateKeyInTimeZone(new Date(requestNow()), timeZone)

  // Commission is the one page whose gate is not a role: admin OR the
  // `manage_staff` permission. The same RPC the page runs is the only way to
  // know whether to offer the link, so it is asked here too.
  const [
    { data: profile },
    { data: canManageStaff },
    { data: settings },
    { data: staff },
    { data: closures },
    { data: taxSetting },
    { data: businessHours },
    { data: publicProfiles },
  ] = await Promise.all([
    supabase.from('profiles').select('role, suspended_at').eq('id', user.id).maybeSingle(),
    supabase.rpc('has_permission', { p_permission: 'manage_staff' }),
    supabase.from('booking_settings').select('*').eq('id', 1).maybeSingle(),
    supabase
      .from('profiles')
      .select('id, first_name, last_name, email, role, accepts_online_booking, suspended_at')
      .neq('role', 'client')
      .order('role'),
    supabase
      .from('closures')
      .select('id, closure_date, reason')
      .gte('closure_date', todayKey)
      .order('closure_date'),
    supabase
      .from('site_settings')
      .select('text_value')
      .eq('key', 'sales_tax_rate')
      .eq('is_active', true)
      .maybeSingle(),
    supabase
      .from('business_hours')
      .select('day_of_week, opens_at, closes_at, is_closed')
      .order('day_of_week'),
    supabase.from('staff_profiles').select('profile_id, is_public'),
  ])

  // Settings is reached by every member of staff now — it is the only route to
  // Locations and the only route to /dashboard/settings/team, which is gated at
  // staff on purpose so a provider can edit her own public profile and see her
  // licence expiry. The layout turned away everyone else already; this is the
  // second lock, and it is what lets the rest of this file stop asking whether
  // there is a user at all.
  if (!profile || !isStaff(profile.role)) redirect('/account')

  // Fresno County's combined rate is the fallback when nothing has been set.
  const parsedRate = Number(taxSetting?.text_value)
  const taxRate =
    Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate < 1 ? parsedRate : 0.0835

  const userIsAdmin = isAdmin(profile.role)
  const userIsManager = isManager(profile.role)
  const userIsFrontDesk = isFrontDesk(profile.role)
  // Always true past the guard above. Kept in the same shape as its siblings so
  // each link goes on recording the gate its own page enforces.
  const userIsStaff = isStaff(profile.role)
  const userIsSuspended = Boolean(profile.suspended_at)

  // Every page under /dashboard/settings, with the gate each one actually
  // enforces. A page that is not listed here is a page nobody finds.
  const groups: SettingsGroup[] = [
    {
      title: 'Booking and the day',
      links: [
        {
          href: '/dashboard/settings/scheduling',
          label: 'Scheduling',
          description:
            'Which bookings wait for someone to look at them before they are confirmed, how much idle time to leave between clients, and which treatments have processing time in the middle.',
          visible: userIsManager,
        },
        {
          href: '/dashboard/settings/resources',
          label: 'Rooms & equipment',
          description:
            'The room, bed, warmer or LED mask a treatment also needs, so a slot with a free provider but no free room is never offered.',
          visible: userIsManager,
        },
        {
          href: '/dashboard/settings/waitlist',
          label: 'Waitlist rules',
          description:
            'What happens to a cancelled appointment: who on the waitlist is told, how many of them at once, and how long the person at the front has it to themselves before the next one hears.',
          visible: userIsAdmin,
        },
        {
          href: '/dashboard/settings/notifications',
          label: 'Client notifications',
          description:
            'The wording of every automatic message a client gets, when reminders and rebooking nudges go out, and what was sent or held back.',
          visible: userIsManager && !userIsSuspended,
        },
      ],
    },
    {
      title: 'People',
      links: [
        {
          href: '/dashboard/settings/team',
          label: 'Team',
          description:
            'What clients read about the people who work here, and the licence numbers, employment record and emergency contact the studio keeps on file.',
          visible: userIsStaff,
        },
        {
          href: '/dashboard/settings/users',
          label: 'User management',
          description:
            'Invite someone, change the role an account holds, or suspend it — every account on the system, clients included.',
          visible: userIsAdmin,
        },
        {
          href: '/dashboard/settings/permissions',
          label: 'Permissions',
          description:
            'Exceptions on top of the role defaults: what one named person may do regardless of the role they hold.',
          visible: userIsAdmin,
        },
        {
          href: '/dashboard/settings/commissions',
          label: 'Commission',
          description:
            'Rate cards for services and retail, who is on which card from which date, and what each person has earned so far this month.',
          visible: userIsAdmin || canManageStaff === true,
        },
      ],
    },
    {
      title: 'The business',
      links: [
        {
          href: '/dashboard/settings/locations',
          label: 'Locations',
          description:
            'Each site’s address, phone and timezone. Not a cosmetic setting: the first open location is what every appointment, sale and stock count is recorded against, and its timezone is the one the opening hours below are read in.',
          visible: userIsAdmin,
        },
        {
          href: '/dashboard/settings/legal',
          label: 'Legal content',
          description:
            'The Terms of Service and Privacy Policy clients agree to. Saving publishes a new version and keeps the old one, so what someone agreed to on the day stays on the record. This pair is what the website serves.',
          visible: userIsAdmin,
        },
        {
          href: '/dashboard/settings/admin',
          label: 'Announcements and tracking',
          description:
            'Announcement banners and the analytics and pixel scripts on the public site. It also carries its own policy editors, which write somewhere the website never reads — edit those under Legal content.',
          visible: userIsAdmin,
        },
      ],
    },
  ]

  const shownGroups = groups
    .map((g) => ({ ...g, links: g.links.filter((l) => l.visible) }))
    .filter((g) => g.links.length > 0)

  // Bookable and listed are different questions — see StaffVisibility.
  const listed = new Map((publicProfiles ?? []).map((r) => [r.profile_id, r.is_public]))
  const visibilityRows: StaffVisibilityRow[] = (staff ?? []).map((s) => ({
    id: s.id,
    name: `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || (s.email ?? 'Team member'),
    bookable: s.accepts_online_booking,
    listed: listed.get(s.id) ?? false,
  }))

  return (
    <div className="max-w-3xl">
      <h1 className="display text-3xl">Settings</h1>
      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        {/* The studio-wide sentence is only true for someone who is shown a
            studio-wide form. Opening hours is the lowest of them (front desk and
            up, per 028), so that is where the wording turns. Both branches say
            "you can reach" rather than "lives under": the list is filtered by
            role, so only an admin ever sees all of it and the stronger claim
            would be false for everyone else. */}
        {userIsFrontDesk ? (
          <>
            Everything you can reach under Settings is listed here. The forms further
            down apply to the whole studio; anything with enough to it to need its own
            page has one.
          </>
        ) : (
          <>
            Everything you can reach under Settings is listed here. The rest of this
            page is what is yours to decide — the studio-wide settings are set by a
            manager.
          </>
        )}
      </p>

      <nav className="mt-10 space-y-10" aria-label="Settings pages">
        {shownGroups.map((group) => (
          <div key={group.title}>
            <h2 className="label-caps text-[var(--color-muted)]">{group.title}</h2>
            <ul className="mt-3 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="group flex items-start justify-between gap-6 py-4"
                  >
                    <span className="block">
                      <span className="block text-sm transition-colors group-hover:text-[var(--color-accent)]">
                        {link.label}
                      </span>
                      <span className="mt-1 block max-w-prose text-xs leading-relaxed text-[var(--color-muted)]">
                        {link.description}
                      </span>
                    </span>
                    <ChevronRight
                      className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)] transition-colors group-hover:text-[var(--color-accent)]"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* `booking_settings` is readable by everyone (003) but writable only by
          is_manager() (029). Showing the form to a provider offered her controls
          the database would refuse on save. */}
      {userIsManager && (
        <section className="mt-14">
          <h2 className="display text-2xl">Booking policy</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            These apply across every provider. Per-service deposits and cancellation
            windows are set on the service itself.
          </p>
          <div className="mt-6">
            {settings ? (
              <BookingSettingsForm settings={settings} />
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                Settings row missing — run migration 003.
              </p>
            )}
          </div>
        </section>
      )}

      {/* A staff directory, not a control: 001 makes the roster legitimately
          staff-readable, and the only thing on it that acts is the admin-only
          button. It stays for whoever books and answers the phone on other
          people's behalf. It goes for a provider, because every name on it is
          also in "Who the public sees" below, where she can actually do
          something — and a page being shortened should not say the same list
          twice. */}
      {userIsFrontDesk && (
        <section className="mt-14">
          <div className="flex items-center justify-between">
            <h2 className="display text-2xl">Staff</h2>
            {userIsAdmin && (
              <Link href="/dashboard/settings/users">
                <Button variant="outline" size="sm">
                  Manage all users
                </Button>
              </Link>
            )}
          </div>
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {(staff ?? []).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div>
                  <p className="text-sm">
                    {s.first_name} {s.last_name}
                  </p>
                  <p className="text-xs text-[var(--color-muted)]">{s.email}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="neutral">{ROLE_LABELS[s.role as UserRole]}</Badge>
                  {/* Not gated on role: the owner is an admin who also does the
                      treatments, and gating this on `provider` hid her status
                      entirely. Bookable is accepts_online_booking, per 020. */}
                  {s.accepts_online_booking && <Badge tone="success">Bookable</Badge>}
                  {s.suspended_at && <Badge tone="danger">Suspended</Badge>}
                </div>
              </li>
            ))}
          </ul>
          {userIsAdmin ? (
            <p className="mt-4 text-xs text-[var(--color-muted)]">
              Use the &ldquo;Manage all users&rdquo; button above to edit roles, suspend
              accounts, and view activity logs.
            </p>
          ) : (
            <p className="mt-4 text-xs text-[var(--color-muted)]">
              Only admins can change roles and suspensions.
            </p>
          )}
        </section>
      )}

      {/* Opening hours is the one studio-wide form here that is not manager-only:
          028 opened `business_hours` writes to is_front_desk(), on the reasoning
          that "we're closing early on Tuesday" should not need the owner. A
          provider is staff but not front desk, so the form is not hers. */}
      {userIsFrontDesk && (
        <section className="mt-14">
          <h2 className="display text-2xl">Opening hours</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Shown in the footer of every page.
          </p>
          <div className="mt-6">
            {(businessHours?.length ?? 0) > 0 ? (
              <BusinessHoursForm hours={(businessHours ?? []) as BusinessHourRow[]} />
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                No hours rows — run migration 010.
              </p>
            )}
          </div>
        </section>
      )}

      {/* `set_sales_tax_rate()` raises for anyone below manager (026), and it is
          the only way the rate moves — the table itself is read-only to staff. */}
      {userIsManager && (
        <section className="mt-14">
          <h2 className="display text-2xl">Sales tax</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Applied to products rung up at the counter. Services are not taxed.
          </p>
          <div className="mt-6">
            <SalesTaxForm rate={taxRate} />
          </div>
        </section>
      )}

      {/* Deliberately NOT gated, and the exception to everything above. 045 gives
          every member of staff the right to take themselves off the booking page
          at any time, and 041 the same for the team page — someone ill, leaving
          or simply full should never have to find an admin first. StaffVisibility
          mirrors that rule per row, so a provider is offered exactly the switches
          the database will honour and nothing else. Hiding this from her would
          take away a right the schema grants; PauseBookings only exists because
          Settings used to be manager-and-above. */}
      <section className="mt-14">
        <h2 className="display text-2xl">Who the public sees</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Two separate things, and both start off. Being an admin, a manager or a
          provider puts nobody on the website — appearing there is always a
          decision someone makes here.
        </p>
        <div className="mt-6">
          <StaffVisibility
            rows={visibilityRows}
            viewerId={user.id}
            viewerIsAdmin={userIsAdmin}
          />
        </div>
      </section>

      {/* `scheduled_job_status()` raises for anyone below manager (044), so admin
          is already tighter than the database requires. Left where it is: the
          brief here is to subtract for providers and the front desk, and widening
          it to manager would add a section a manager does not see today. */}
      {userIsAdmin && <ScheduledJobs />}

      {/* Read-only for everybody — 003 makes closures publicly readable and
          admin-writable, and there is no control here to be wrong about. A day
          the studio is shut is something a provider needs to know. */}
      <section className="mt-14">
        <h2 className="display text-2xl">Upcoming closures</h2>
        {(closures?.length ?? 0) === 0 ? (
          <p className="mt-4 text-sm text-[var(--color-muted)]">None scheduled.</p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {(closures ?? []).map((c) => (
              <li key={c.id} className="flex justify-between gap-4 py-3 text-sm">
                <span className="tabular-nums">
                  {new Date(`${c.closure_date}T00:00:00`).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'long',
                    day: 'numeric',
                  })}
                </span>
                <span className="text-[var(--color-muted)]">{c.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
