import Link from 'next/link'
import Image from 'next/image'
import { redirect } from 'next/navigation'
import { CalendarClock, ShieldCheck, UserRound, UserRoundPen, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { requestNow } from '@/lib/time'
import { isAdmin, isManager, isStaff, ROLE_LABELS, type UserRole } from '@/types/database'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import {
  Avatar,
  EmptyState,
  HeroPanel,
  HowItWorks,
  PageHeader,
  Panel,
} from '@/components/ui/dashboard'
import { StaffProfileEditor } from '@/components/shared/StaffProfileEditor'
import { StaffProfileInternal } from '@/components/shared/StaffProfileInternal'
import { StaffProfileLicenceBadge } from '@/components/shared/StaffProfileLicenceBadge'
import {
  StaffProfileLicences,
  type LicenceRow,
} from '@/components/shared/StaffProfileLicences'
import {
  formatDateKey,
  loadStaffLocations,
  type StaffCredential,
  type StaffEmployment,
  type StaffProfile,
} from '@/types/team'

export const dynamic = 'force-dynamic'

const PROFILE_COLUMNS =
  'profile_id, is_public, display_name, slug, headline, bio, pronouns, photo_url, specialities, certifications, languages, years_experience, instagram_url, tiktok_url, website_url, sort_order, created_at, updated_at'

/** Inline links inside the explanatory cards, so they read as prose and not as buttons. */
const PROSE_LINK = 'underline underline-offset-4 hover:text-[var(--color-accent)]'

/**
 * A team member at the head of their own panel.
 *
 * The kit's Avatar is initials only, and says why: nobody in the CRM uploaded a
 * photograph, and a face beside clinical notes is a decision that component does
 * not get to make. Staff are the exception — `staff_profiles.photo_url` is
 * uploaded from the form further down this very page, by the person in it, to be
 * shown to the public. So the photograph is used when there is one and the
 * initials are what happens when there is not.
 *
 * `unoptimized` for the same reason StaffProfileEditor uses it: the URL is
 * whatever the storage bucket handed back, and a fresh upload should appear
 * immediately rather than after the optimiser catches up.
 */
function TeamAvatar({ name, photoUrl }: { name: string; photoUrl: string | null }) {
  if (!photoUrl) return <Avatar name={name} className="h-12 w-12 text-base" />

  return (
    <span
      data-ui="tile"
      className="relative block h-12 w-12 shrink-0 overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-background)]"
    >
      <Image src={photoUrl} alt="" fill sizes="48px" className="object-cover" unoptimized />
    </span>
  )
}

export default async function TeamSettingsPage() {
  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/team')

  const { data: me } = await supabase
    .from('profiles')
    .select('role, first_name, last_name, display_name')
    .eq('id', user.id)
    .maybeSingle()

  // The layout already turned away anyone who is not staff; this is the second
  // lock, in the same spirit as the one on the layout itself.
  if (!me || !isStaff(me.role)) redirect('/account')

  const role = me.role as UserRole
  const manager = isManager(role)
  // The viewer's own role. Only Locations is admin-only, and only an admin is
  // offered the link to it — /dashboard/settings/locations bounces everyone else.
  const admin = isAdmin(role)

  // RLS decides what comes back here, not the query. A provider gets exactly
  // her own row from each of these; a manager gets everyone's. The `.eq()` on
  // the non-manager path is a courtesy to the reader and to the planner.
  const teamQuery = supabase.from('staff_profiles').select(PROFILE_COLUMNS)
  const [
    { data: teamRows },
    { data: credentialRows },
    { data: employmentRows },
    { data: staffRows },
    { data: canManageStaff },
  ] = await Promise.all([
    manager
      ? teamQuery.order('sort_order').order('display_name')
      : teamQuery.eq('profile_id', user.id),
    supabase
      .from('staff_credentials')
      .select(
        'profile_id, licence_number, licence_type, licence_state, licence_issued_on, licence_expires_on, verified_at, verified_by, expiry_reminder_stage, expiry_reminded_at, created_at, updated_at'
      ),
    manager
      ? supabase
          .from('staff_employment')
          .select(
            'profile_id, started_on, ended_on, employment_type, emergency_contact_name, emergency_contact_phone, emergency_contact_relationship, internal_notes, updated_by, created_at, updated_at'
          )
      : Promise.resolve({ data: [] }),
    supabase
      .from('profiles')
      .select('id, first_name, last_name, display_name, role, accepts_online_booking, suspended_at')
      .neq('role', 'client'),
    // Commission is the one linked page whose gate is not a role: admin, or the
    // `manage_staff` permission. Asking the same RPC the page itself asks is the
    // only way to know whether to offer the link or state the fact in plain text.
    supabase.rpc('has_permission', { p_permission: 'manage_staff' }),
  ])

  const team = (teamRows ?? []) as StaffProfile[]
  const credentials = new Map(
    ((credentialRows ?? []) as StaffCredential[]).map((c) => [c.profile_id, c])
  )
  const employment = new Map(
    ((employmentRows ?? []) as StaffEmployment[]).map((e) => [e.profile_id, e])
  )
  const staffPeople = (staffRows ?? []) as {
    id: string
    first_name: string | null
    last_name: string | null
    display_name: string | null
    role: UserRole
    accepts_online_booking: boolean
    suspended_at: string | null
  }[]
  const staffById = new Map(staffPeople.map((s) => [s.id, s]))

  const locations = await loadStaffLocations(
    supabase,
    team.map((t) => t.profile_id)
  )

  const mine = team.find((t) => t.profile_id === user.id) ?? null
  const others = team.filter((t) => t.profile_id !== user.id)
  const myCredential = credentials.get(user.id) ?? null

  const licenceRows: LicenceRow[] = manager
    ? team.map((t) => ({
        profile_id: t.profile_id,
        name: t.display_name,
        licence_expires_on: credentials.get(t.profile_id)?.licence_expires_on ?? null,
      }))
    : []

  // The studio's headcount, not the viewer's. `staff_profiles` is narrowed by
  // RLS to the rows this person may edit — one row, for a provider — but every
  // member of staff may read `profiles` (001), so this is the real number. It
  // decides which of the two things the panel at the top says, and it counts
  // only people who can still get in: a suspended account is not a colleague.
  const soloPractitioner = staffPeople.filter((s) => !s.suspended_at).length <= 1

  const commissionsVisible = admin || canManageStaff === true

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Team"
        lede="What clients read about you, and what the studio has to keep on file."
        actions={
          <ButtonLink href="/team" variant="subtle" size="sm">
            See the public page
          </ButtonLink>
        }
      />

      {/* Two states, one panel. A single-room studio with one practitioner is
          the ordinary case here, not a setup step left half-finished, so it is
          told what this page is for rather than nagged to build a team. */}
      <HeroPanel
        className="mt-8"
        icon={soloPractitioner ? UserRound : Users}
        title={soloPractitioner ? 'A studio of one' : 'Staff'}
        lede={
          soloPractitioner ? (
            <>
              One practitioner, one room — and everything on this page is yours: the page
              clients read about you, the licence the state expects on file, and the hours
              every bookable slot is generated from. When help does arrive, an admin
              invites them and their record appears alongside yours.
            </>
          ) : (
            <>
              Everyone who works here, in one place — the page clients read, the licence
              the studio keeps on file, and the personnel record behind both. How much of
              it opens depends on the role you hold.
            </>
          )
        }
        actions={
          <>
            <ButtonLink href="#your-profile">Edit your profile</ButtonLink>
            {admin ? (
              <ButtonLink href="/dashboard/settings/users" variant="outline">
                Invite someone
              </ButtonLink>
            ) : (
              <ButtonLink href="/dashboard/calendar/hours" variant="outline">
                Your hours
              </ButtonLink>
            )}
          </>
        }
        image={{ src: '/images/about.jpg', alt: '' }}
      />

      {manager && (
        <section className="mt-10">
          <Panel className="p-6 sm:p-8">
            <StaffProfileLicences rows={licenceRows} now={now} />
          </Panel>
        </section>
      )}

      {/* The panel's first pill lands here, and the header is sticky — hence the
          scroll margin, so the heading is not parked under it. */}
      <section id="your-profile" className="mt-12 scroll-mt-24">
        <h2 className="display text-2xl">Your profile</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Yours to write, including whether it appears on the website at all.
        </p>

        <Panel className="mt-6 p-6 sm:p-8">
          {mine ? (
            <>
              <div className="mb-8 flex flex-wrap items-center gap-4 border-b border-[var(--color-border)] pb-6">
                <TeamAvatar name={mine.display_name} photoUrl={mine.photo_url} />
                <div className="min-w-0 flex-1">
                  <p className="text-base">{mine.display_name}</p>
                  {mine.headline && (
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">{mine.headline}</p>
                  )}
                </div>
                <Badge tone="neutral">{ROLE_LABELS[role]}</Badge>
              </div>
              <StaffProfileEditor
                profile={mine}
                isSelf
                isManager={manager}
                isAdmin={admin}
                locations={locations.get(mine.profile_id) ?? []}
              />
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              No profile row yet — one is created the moment an account becomes staff. If
              you are seeing this, ask an admin to re-save your role.
            </p>
          )}
        </Panel>

        {!manager && (
          <Panel className="mt-6 p-6">
            <p className="label-caps mb-3 text-[var(--color-muted)]">Your licence</p>
            {myCredential?.licence_expires_on ? (
              <div className="flex flex-wrap items-center gap-4">
                <p className="text-sm tabular-nums">
                  Expires {formatDateKey(myCredential.licence_expires_on)}
                </p>
                <StaffProfileLicenceBadge
                  expiresOn={myCredential.licence_expires_on}
                  now={now}
                />
              </div>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                Nothing on file yet.
              </p>
            )}
            <p className="mt-3 max-w-prose text-xs leading-relaxed text-[var(--color-muted)]">
              Renewals are recorded by a manager, so that what is on file is what someone
              actually checked. You will be reminded at 60, 30, 14 and 7 days — tell
              whoever runs the studio as soon as you have renewed.
            </p>
          </Panel>
        )}
      </section>

      {manager && (
        <section className="mt-12">
          <h2 className="display text-2xl">Everyone else</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Licences, personnel records and, if you need to, someone&rsquo;s public page.
          </p>

          {others.length === 0 ? (
            // Inviting is an admin's job — /dashboard/settings/users redirects
            // everyone else to /dashboard — and this block is reached by any
            // manager. So a manager is told who to ask, not sent to a door that
            // shuts in her face.
            <EmptyState
              className="mt-6"
              icon={Users}
              title="Nobody else on the books"
              description={
                admin
                  ? 'Everyone who joins gets a profile of their own the moment their account becomes staff.'
                  : 'An admin invites people to the studio; their records appear here once they do.'
              }
              action={
                admin ? (
                  <ButtonLink href="/dashboard/settings/users" variant="subtle" size="sm">
                    User management
                  </ButtonLink>
                ) : undefined
              }
            />
          ) : (
            <div className="mt-6 space-y-6">
              {others.map((member) => {
                const person = staffById.get(member.profile_id)
                return (
                  <Panel key={member.profile_id} className="p-6 sm:p-8">
                    <div className="flex flex-wrap items-center gap-3">
                      <TeamAvatar name={member.display_name} photoUrl={member.photo_url} />
                      <div className="min-w-0 flex-1">
                        <h3 className="display text-xl">{member.display_name}</h3>
                        {member.headline && (
                          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                            {member.headline}
                          </p>
                        )}
                      </div>
                      {person && <Badge tone="neutral">{ROLE_LABELS[person.role]}</Badge>}
                      {person?.suspended_at && <Badge tone="danger">Suspended</Badge>}
                      <StaffProfileLicenceBadge
                        expiresOn={credentials.get(member.profile_id)?.licence_expires_on ?? null}
                        now={now}
                      />
                    </div>

                    <div className="mt-8">
                      <StaffProfileInternal
                        profileId={member.profile_id}
                        personName={member.display_name}
                        credential={credentials.get(member.profile_id) ?? null}
                        employment={employment.get(member.profile_id) ?? null}
                        now={now}
                      />
                    </div>

                    <details className="mt-8 border-t border-[var(--color-border)] pt-4">
                      <summary className="label-caps min-h-11 cursor-pointer py-3 text-[var(--color-muted)] hover:text-[var(--color-accent)]">
                        Edit their public profile
                      </summary>
                      <div className="mt-6">
                        <StaffProfileEditor
                          profile={member}
                          isSelf={false}
                          isManager
                          isAdmin={admin}
                          locations={locations.get(member.profile_id) ?? []}
                        />
                      </div>
                    </details>
                  </Panel>
                )
              })}
            </div>
          )}
        </section>
      )}

      {manager && mine && (
        <section className="mt-12">
          <h2 className="display text-2xl">Your own record</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            You can see this because you are a manager, not because it is yours. A
            provider never sees their own.
          </p>
          <Panel className="mt-6 p-6 sm:p-8">
            <StaffProfileInternal
              profileId={mine.profile_id}
              personName={mine.display_name}
              credential={credentials.get(mine.profile_id) ?? null}
              employment={employment.get(mine.profile_id) ?? null}
              now={now}
            />
          </Panel>
        </section>
      )}

      {/* Last, not first. This is for the first week rather than the hundredth
          day, and every link in it is a door the viewer can actually open —
          Commission and Permissions turn away anyone else, so for them the same
          fact is stated in plain text instead. */}
      <HowItWorks
        className="mt-16 border-t border-[var(--color-border)] pt-12"
        items={[
          {
            icon: UserRoundPen,
            title: 'Everything a client reads',
            body: (
              <>
                Photograph, biography, specialities, training and languages — each person
                writes their own. One switch publishes it to{' '}
                <Link href="/team" className={PROSE_LINK}>
                  the team page
                </Link>{' '}
                or takes it down again, and nobody has to approve that.
              </>
            ),
          },
          {
            icon: CalendarClock,
            title: 'Hours, time worked and what it pays',
            body: (
              <>
                Working hours, days off, the treatments someone is assigned to and their
                Google Calendar all sit under{' '}
                <Link href="/dashboard/calendar/hours" className={PROSE_LINK}>
                  My hours
                </Link>
                . Shifts are clocked from the top of any page here and settled on{' '}
                <Link href="/dashboard/calendar/timesheets" className={PROSE_LINK}>
                  Timesheets
                </Link>
                {commissionsVisible ? (
                  <>
                    , and the rate cards behind a commission cheque are under{' '}
                    <Link href="/dashboard/settings/commissions" className={PROSE_LINK}>
                      Commission
                    </Link>
                  </>
                ) : (
                  <>, and commission rate cards are kept by an admin</>
                )}
                .
              </>
            ),
          },
          {
            icon: ShieldCheck,
            title: 'Roles, permissions and licences',
            body: (
              <>
                A role decides which doors open: a provider keeps her own diary and her
                own clients, the front desk books for anyone, a manager gets stock and
                analytics.{' '}
                {admin ? (
                  <>
                    Accounts and roles are under{' '}
                    <Link href="/dashboard/settings/users" className={PROSE_LINK}>
                      User management
                    </Link>
                    , one-off exceptions under{' '}
                    <Link href="/dashboard/settings/permissions" className={PROSE_LINK}>
                      Permissions
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    Both roles and one-off exceptions are an admin&rsquo;s to set, and the
                    database refuses a change to anyone&rsquo;s role from anyone else.
                  </>
                )}{' '}
                Licence expiry is tracked here: the holder and every manager are reminded
                at 60, 30, 14 and 7 days, and again the day it lapses.
              </>
            ),
          },
        ]}
      />
    </div>
  )
}
