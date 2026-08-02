import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SectionTabs } from '@/components/layout/SectionTabs'
import { isManager } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Paperwork, in one place.
 *
 * These three pages were previously scattered — consent templates behind a tab
 * on Services, intake templates nowhere at all, and "who still owes a form"
 * only discoverable by opening clients one at a time. They are one job.
 *
 * The role read is the one query in this section that earns its keep. Only the
 * outstanding list is open to every staff member; both template pages end in an
 * `is_manager` gate and redirect out to /dashboard. Without the role here the
 * bar offers a provider two doors that eject them from the section with no
 * explanation — so this query is what stops the section advertising a page it
 * will not let you open. Hiding a tab is not a security control; the gates on
 * consent/ and intake/ stay exactly where they are and remain the thing that
 * actually decides, this only stops the UI lying about it.
 *
 * With both template tabs hidden, SectionTabs drops to a single tab and renders
 * nothing — which is right. For a provider, Forms *is* the outstanding list.
 */
export default async function FormsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/forms')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // Least privilege on a missing profile, matching the page-level gates.
  const editsTemplates = isManager(profile?.role ?? 'provider')

  return (
    <div>
      <h1 className="display text-3xl">Forms</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        {editsTemplates
          ? 'What clients fill in before treatment — health history, and the consent they give. Signed forms are kept verbatim and cannot be rewritten by editing a template later.'
          : 'Who still owes what before they arrive — health history, and the consent they give. A form is outstanding when the client has never filled it in, or the last one has expired and needs signing again.'}
      </p>

      <SectionTabs
        label="Forms"
        root="/dashboard/forms"
        tabs={[
          { href: '/dashboard/forms', label: 'Outstanding' },
          {
            href: '/dashboard/forms/consent',
            label: 'Consent forms',
            visible: editsTemplates,
          },
          {
            href: '/dashboard/forms/intake',
            label: 'Intake forms',
            visible: editsTemplates,
          },
        ]}
      />

      <div className="mt-10">{children}</div>
    </div>
  )
}
