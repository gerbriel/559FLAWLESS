import { redirect } from 'next/navigation'

// The page moved under Catalog (/dashboard/memberships); old links and bookmarks land here.
export default function MembershipsSettingsRedirect() {
  redirect('/dashboard/memberships')
}
