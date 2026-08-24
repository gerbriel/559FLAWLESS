import { createPublicClient } from '@/lib/supabase/public'

/**
 * The words on a page, when nobody has changed them yet.
 *
 * Most storefront copy was written as literals in JSX — section headings,
 * ledes, the sentence under a grid. That is the right place for text nobody
 * intends to change, and the wrong place the moment the studio wants to change
 * it without asking anyone.
 *
 * So each page reads a `site_content` row and renders `copy.x ?? 'the literal'`.
 * Until somebody edits it there is no row at all, the fallback renders, and the
 * page reads exactly as it did before — the literal in the file stays the
 * source of truth for what it *should* say. The first edit creates the row.
 *
 * That means no migration and no seeding: adding a new editable line is one
 * `?? 'default'` and one attribute, and deleting the row anywhere puts the
 * original wording back.
 */
export async function pageCopy(key: string): Promise<Record<string, string>> {
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('site_content')
    .select('value')
    .eq('key', key)
    .maybeSingle()
  return (data?.value ?? {}) as Record<string, string>
}
