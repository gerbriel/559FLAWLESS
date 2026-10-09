import { SectionTabs } from '@/components/layout/SectionTabs'
import { createClient } from '@/lib/supabase/server'

/**
 * Time, in one place.
 *
 * The diary, your own working hours, and the clock you punch are three views of
 * the same question — where does the day go. They used to be three sidebar
 * entries; they are now one, with a toggle.
 *
 * No heading here on purpose. "My hours" and "Timesheets" keep their own,
 * because each has chrome that has to hang off one (the bookable-online badge,
 * the scope-and-zone label). The diary has none, so the active tab is the only
 * thing that needs to name it — a second "Calendar" 40px below was repetition.
 *
 * One thing is fetched: the studio's two switches (077). With the clock off,
 * Timesheets is not a tab; with My hours off, neither is My hours. The tabs are otherwise visible to every staff
 * member — the sidebar entries these replaced were all ungated.
 */
export default async function CalendarSectionLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('time_clock_enabled, my_hours_enabled')
    .eq('id', 1)
    .maybeSingle()
  const timeClock = settings?.time_clock_enabled ?? true
  const myHours = settings?.my_hours_enabled ?? true

  return (
    <div>
      <SectionTabs
        label="Schedule"
        root="/dashboard/calendar"
        tabs={[
          { href: '/dashboard/calendar', label: 'Calendar' },
          ...(myHours ? [{ href: '/dashboard/calendar/hours', label: 'My hours' }] : []),
          ...(timeClock ? [{ href: '/dashboard/calendar/timesheets', label: 'Timesheets' }] : []),
        ]}
      />

      <div className="mt-10">{children}</div>
    </div>
  )
}
