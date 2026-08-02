import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requestNow } from '@/lib/time'
import { isManager, isStaff, ROLE_LABELS, type UserRole } from '@/types/database'
import { Badge } from '@/components/ui/badge'
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

  // RLS decides what comes back here, not the query. A provider gets exactly
  // her own row from each of these; a manager gets everyone's. The `.eq()` on
  // the non-manager path is a courtesy to the reader and to the planner.
  const teamQuery = supabase.from('staff_profiles').select(PROFILE_COLUMNS)
  const [{ data: teamRows }, { data: credentialRows }, { data: employmentRows }, { data: staffRows }] =
    await Promise.all([
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
    ])

  const team = (teamRows ?? []) as StaffProfile[]
  const credentials = new Map(
    ((credentialRows ?? []) as StaffCredential[]).map((c) => [c.profile_id, c])
  )
  const employment = new Map(
    ((employmentRows ?? []) as StaffEmployment[]).map((e) => [e.profile_id, e])
  )
  const staffById = new Map(
    ((staffRows ?? []) as {
      id: string
      first_name: string | null
      last_name: string | null
      display_name: string | null
      role: UserRole
      accepts_online_booking: boolean
      suspended_at: string | null
    }[]).map((s) => [s.id, s])
  )

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

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="display text-3xl">Team</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            What clients read about you, and what the studio has to keep on file.
          </p>
        </div>
        <Link
          href="/team"
          className="label-caps min-h-11 self-center text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        >
          See the public page
        </Link>
      </div>

      {manager && (
        <section className="mt-12 border-b border-[var(--color-border)] pb-12">
          <StaffProfileLicences rows={licenceRows} now={now} />
        </section>
      )}

      <section className="mt-12">
        <h2 className="display text-2xl">Your profile</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Yours to write, including whether it appears on the website at all.
        </p>

        <div className="mt-8">
          {mine ? (
            <StaffProfileEditor
              profile={mine}
              isSelf
              isManager={manager}
              locations={locations.get(mine.profile_id) ?? []}
            />
          ) : (
            <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-muted)]">
              No profile row yet — one is created the moment an account becomes staff. If
              you are seeing this, ask an admin to re-save your role.
            </p>
          )}
        </div>

        {!manager && (
          <div className="mt-10 border-l-2 border-[var(--color-border)] pl-6">
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
          </div>
        )}
      </section>

      {manager && (
        <section className="mt-16">
          <h2 className="display text-2xl">Everyone else</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Licences, personnel records and, if you need to, someone&rsquo;s public page.
          </p>

          {others.length === 0 ? (
            <p className="mt-8 text-sm text-[var(--color-muted)]">
              Nobody else on the books. Invite someone from{' '}
              <Link href="/dashboard/settings/users" className="underline underline-offset-4">
                User management
              </Link>
              .
            </p>
          ) : (
            <div className="mt-8 space-y-16">
              {others.map((member) => {
                const person = staffById.get(member.profile_id)
                return (
                  <div
                    key={member.profile_id}
                    className="border-t border-[var(--color-border)] pt-10"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="display text-xl">{member.display_name}</h3>
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

                    <details className="mt-8">
                      <summary className="label-caps min-h-11 cursor-pointer py-3 text-[var(--color-muted)] hover:text-[var(--color-accent)]">
                        Edit their public profile
                      </summary>
                      <div className="mt-6">
                        <StaffProfileEditor
                          profile={member}
                          isSelf={false}
                          isManager
                          locations={locations.get(member.profile_id) ?? []}
                        />
                      </div>
                    </details>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {manager && mine && (
        <section className="mt-16 border-t border-[var(--color-border)] pt-10">
          <h2 className="display text-2xl">Your own record</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            You can see this because you are a manager, not because it is yours. A
            provider never sees their own.
          </p>
          <div className="mt-8">
            <StaffProfileInternal
              profileId={mine.profile_id}
              personName={mine.display_name}
              credential={credentials.get(mine.profile_id) ?? null}
              employment={employment.get(mine.profile_id) ?? null}
              now={now}
            />
          </div>
        </section>
      )}
    </div>
  )
}
