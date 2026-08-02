import { SectionTabs } from '@/components/layout/SectionTabs'

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
 * Nothing is fetched here either. Two of the three tabs would pay for a query
 * they never read, and the tabs themselves are visible to every staff member —
 * the sidebar entries these replaced were all ungated.
 */
export default function CalendarSectionLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div>
      <SectionTabs
        label="Schedule"
        root="/dashboard/calendar"
        tabs={[
          { href: '/dashboard/calendar', label: 'Calendar' },
          { href: '/dashboard/calendar/hours', label: 'My hours' },
          { href: '/dashboard/calendar/timesheets', label: 'Timesheets' },
        ]}
      />

      <div className="mt-10">{children}</div>
    </div>
  )
}
