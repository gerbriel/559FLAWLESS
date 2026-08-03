/**
 * The menu, and nothing else.
 *
 * This section used to hold two pages behind a tab bar — the services and the
 * categories they are grouped into. The categories moved out to
 * `/dashboard/categories`, where the service and product groupings sit side by
 * side, because "what are the groupings" turned out to be one question asked of
 * two tables rather than a footnote to the service list.
 *
 * So the tab bar is gone rather than repointed. A tab whose href leaves the
 * section it is drawn in cannot ever be the active one — `SectionTabs` matches
 * children by prefix, and the moment it is followed this layout unmounts — so
 * it would render a bar with nothing lit and take the user somewhere the bar
 * does not describe. `ServicesCatalogue` already carries the link to Categories
 * in the sentence that explains what a category is for, which is where someone
 * looking for it actually is.
 *
 * The layout stays as a passthrough rather than being deleted: it is the place
 * a second Services page would hang its tabs from, and removing the file to add
 * it back is churn. It deliberately adds no wrapper — the tab bar was what the
 * old `mt-8` spaced away from.
 */
export default function ServicesLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
