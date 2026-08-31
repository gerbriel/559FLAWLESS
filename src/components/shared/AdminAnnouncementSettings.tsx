'use client'

import type { Announcement, AnnouncementAudience } from '@/types/database'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Textarea, Field, Select } from '@/components/ui/field'
import { ImageField } from '@/components/shared/ImageField'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Plus, Trash2, Edit2, Eye, MousePointerClick, XCircle } from 'lucide-react'

type Variant = 'info' | 'promo' | 'urgent'

/**
 * The three presets, with the colours they actually render as.
 *
 * `swatch` and `ink` are duplicated from the announcement styles rather than
 * imported, because these are what the *preview* paints — if the two ever
 * diverge the preview would lie, and a wrong preview is worse than none.
 */
const TEMPLATES: { value: Variant; label: string; hint: string; swatch: string; ink: string }[] = [
  {
    value: 'info',
    label: 'Quiet',
    hint: 'Studio news, hours, notices.',
    swatch: '#2b2320',
    ink: '#faf7f5',
  },
  {
    value: 'promo',
    label: 'Offer',
    hint: 'Specials and new-client pricing.',
    swatch: '#efe7e1',
    ink: '#2b2320',
  },
  {
    value: 'urgent',
    label: 'Urgent',
    hint: 'Closures and same-day changes.',
    swatch: '#b3261e',
    ink: '#ffffff',
  },
]

/** Relative luminance per WCAG 2.1, for the contrast check below. */
function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

/** WCAG contrast ratio, 1–21. Null if either colour isn't a #RRGGBB. */
function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return null
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

export interface AnnouncementStat {
  announcement_id: number
  views: number
  clicks: number
  dismissals: number
  click_rate: number
}

interface Props {
  announcements: Announcement[]
  stats?: AnnouncementStat[]
}

export function AdminAnnouncementSettings({ announcements, stats = [] }: Props) {
  const router = useRouter()
  // The list renders straight from props — router.refresh() after every write
  // is what updates it. It used to be copied into useState once at mount,
  // which meant a saved edit never appeared in the list, and worse: pressing
  // Edit again re-filled the form from the stale copy, so the NEXT save wrote
  // the old values back over the first one. Props can't go stale.
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [formData, setFormData] = useState({
    title: '',
    body: '',
    link_url: '',
    link_label: '',
    variant: 'info' as 'info' | 'promo' | 'urgent',
    background_color: '',
    text_color: '',
    starts_at: '',
    ends_at: '',
    is_active: true,
    // Presentation (018)
    display_style: 'banner' as 'banner' | 'modal' | 'corner' | 'inline',
    image_url: '',
    dismissible: true,
    dismiss_scope: 'session' as 'session' | 'persist' | 'never',
    delay_seconds: 0,
    // Targeting (014)
    audience_type: 'all' as 'all' | 'anonymous' | 'authenticated' | 'role',
    audience_roles: [] as string[],
    target_pages: '',
    priority: 0,
  })
  const [loading, setLoading] = useState(false)

  const statFor = new Map(stats.map((s) => [s.announcement_id, s]))

  /**
   * The storefront paints announcements inside its cached public layout
   * (revalidate 300), so without this a saved change takes up to five minutes
   * to show on the site — which reads as "it didn't save". Same seam the
   * in-place page editor uses; best effort, the write already succeeded.
   */
  const bustPublicCache = () =>
    fetch('/api/admin/revalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paths: ['/', '/services', '/shop', '/about', '/faq', '/team', '/policies', '/contact', '/gift-cards'],
      }),
    }).catch(() => {})

  const preset = TEMPLATES.find((t) => t.value === formData.variant) ?? TEMPLATES[0]

  // A banner nobody can read is worse than no banner. Warn rather than block:
  // the studio may be pairing a colour with an image where the rule doesn't
  // apply, and it is their sign to hang.
  const ratio = contrastRatio(
    formData.background_color || preset.swatch,
    formData.text_color || preset.ink
  )
  const contrastWarning =
    ratio !== null && ratio < 4.5
      ? `Those two colours only reach ${ratio.toFixed(1)}:1 contrast. Under about 4.5:1 the text gets hard to read — try a darker text or a lighter background.`
      : null
  const [error, setError] = useState<string | null>(null)

  const resetForm = () => {
    setFormData({
      title: '',
      body: '',
      link_url: '',
      link_label: '',
      variant: 'info',
      background_color: '',
      text_color: '',
      starts_at: '',
      ends_at: '',
      is_active: true,
      display_style: 'banner',
      image_url: '',
      dismissible: true,
      dismiss_scope: 'session',
      delay_seconds: 0,
      audience_type: 'all',
      audience_roles: [],
      target_pages: '',
      priority: 0,
    })
    setEditing(null)
    setError(null)
  }

  const handleEdit = (announcement: Announcement) => {
    setFormData({
      title: announcement.title,
      body: announcement.body ?? '',
      link_url: announcement.link_url ?? '',
      link_label: announcement.link_label ?? '',
      variant: announcement.variant,
      background_color: announcement.background_color ?? '',
      text_color: announcement.text_color ?? '',
      starts_at: announcement.starts_at ? announcement.starts_at.split('T')[0] : '',
      ends_at: announcement.ends_at ? announcement.ends_at.split('T')[0] : '',
      is_active: announcement.is_active,
      display_style: (announcement.display_style ?? 'banner') as typeof formData.display_style,
      image_url: announcement.image_url ?? '',
      dismissible: announcement.dismissible ?? true,
      dismiss_scope: (announcement.dismiss_scope ?? 'session') as typeof formData.dismiss_scope,
      delay_seconds: announcement.delay_seconds ?? 0,
      audience_type: (announcement.target_audience?.type ?? 'all') as typeof formData.audience_type,
      audience_roles:
        announcement.target_audience && 'roles' in announcement.target_audience
          ? [...announcement.target_audience.roles]
          : [],
      target_pages: (announcement.target_pages ?? []).join('\n'),
      priority: announcement.priority ?? 0,
    })
    setEditing(announcement.id)
  }

  const handleSave = async () => {
    if (!formData.title.trim()) {
      setError('Title is required')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const supabase = createClient()

      const data: Partial<Announcement> = {
        title: formData.title.trim(),
        body: formData.body.trim() || null,
        link_url: formData.link_url.trim() || null,
        link_label: formData.link_label.trim() || null,
        variant: formData.variant,
        background_color: formData.background_color || null,
        text_color: formData.text_color || null,
        starts_at: formData.starts_at ? new Date(formData.starts_at).toISOString() : null,
        ends_at: formData.ends_at ? new Date(formData.ends_at).toISOString() : null,
        is_active: formData.is_active,

        display_style: formData.display_style,
        image_url: formData.image_url.trim() || null,
        // A modal with no way out traps the visitor; the DB rejects it too.
        dismissible: formData.display_style === 'modal' ? true : formData.dismissible,
        dismiss_scope: formData.dismiss_scope,
        delay_seconds: Number(formData.delay_seconds) || 0,

        target_audience: (formData.audience_type === 'role'
          ? { type: 'role', roles: formData.audience_roles }
          : { type: formData.audience_type }) as AnnouncementAudience,
        // One path per line, blanks ignored. Empty means every page.
        target_pages: formData.target_pages
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        priority: Number(formData.priority) || 0,
      }

      if (editing === 'new') {
        const { error: insertError } = await supabase
          .from('announcements')
          .insert(data)

        if (insertError) throw insertError
      } else if (editing !== null) {
        // `editing` is number | 'new' | null; this branch has already ruled out
        // 'new', and the null check makes it a plain id.
        const { error: updateError } = await supabase
          .from('announcements')
          .update(data)
          .eq('id', editing)

        if (updateError) throw updateError
      }

      await bustPublicCache()
      router.refresh()
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this announcement?')) return

    setLoading(true)
    setError(null)

    try {
      const supabase = createClient()

      const { error: deleteError } = await supabase
        .from('announcements')
        .delete()
        .eq('id', id)

      if (deleteError) throw deleteError

      await bustPublicCache()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setLoading(false)
    }
  }

  const handleToggleActive = async (id: number, currentState: boolean) => {
    setLoading(true)
    try {
      const supabase = createClient()

      const { error: updateError } = await supabase
        .from('announcements')
        .update({ is_active: !currentState })
        .eq('id', id)

      if (updateError) throw updateError

      await bustPublicCache()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Announcement List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Active Announcements</CardTitle>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                resetForm()
                setEditing('new')
              }}
            >
              <Plus className="h-4 w-4" />
              New Announcement
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {announcements.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">No announcements yet.</p>
          ) : (
            <ul className="space-y-3">
              {announcements.map((announcement) => (
                <li
                  key={announcement.id}
                  className="flex items-start justify-between border border-[var(--color-border)] p-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{announcement.title}</p>
                      <Badge tone={
                        announcement.variant === 'urgent' ? 'danger' :
                        announcement.variant === 'promo' ? 'success' : 'info'
                      }>
                        {announcement.variant}
                      </Badge>
                      {!announcement.is_active && (
                        <Badge tone="neutral">Inactive</Badge>
                      )}
                    </div>
                    {announcement.body && (
                      <p className="mt-1 text-sm text-[var(--color-muted)]">
                        {announcement.body}
                      </p>
                    )}
                    {announcement.link_url && (
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        Link: {announcement.link_label || announcement.link_url}
                      </p>
                    )}

                    {/* How it actually performed. Views are counted once per
                        session, so a header banner does not score an
                        impression on every page a visitor opens. */}
                    {(() => {
                      const stat = statFor.get(announcement.id)
                      if (!stat || stat.views === 0) {
                        return (
                          <p className="mt-2 text-xs text-[var(--color-muted)]">
                            No views recorded yet.
                          </p>
                        )
                      }
                      return (
                        <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-muted)]">
                          <div className="flex items-center gap-1.5">
                            <Eye className="h-3 w-3" strokeWidth={1.75} />
                            <dt className="sr-only">Views</dt>
                            <dd className="tabular-nums">{stat.views} seen</dd>
                          </div>
                          {announcement.link_url && (
                            <>
                              <div className="flex items-center gap-1.5">
                                <MousePointerClick className="h-3 w-3" strokeWidth={1.75} />
                                <dt className="sr-only">Clicks</dt>
                                <dd className="tabular-nums">{stat.clicks} clicked</dd>
                              </div>
                              <div>
                                <dt className="sr-only">Click rate</dt>
                                <dd className="tabular-nums text-[var(--color-accent)]">
                                  {stat.click_rate}%
                                </dd>
                              </div>
                            </>
                          )}
                          {stat.dismissals > 0 && (
                            <div className="flex items-center gap-1.5">
                              <XCircle className="h-3 w-3" strokeWidth={1.75} />
                              <dt className="sr-only">Dismissed</dt>
                              <dd className="tabular-nums">{stat.dismissals} closed it</dd>
                            </div>
                          )}
                        </dl>
                      )
                    })()}
                    <div className="mt-2 text-xs text-[var(--color-muted)]">
                      {announcement.starts_at && (
                        <span>
                          Starts: {new Date(announcement.starts_at).toLocaleDateString()}
                        </span>
                      )}
                      {announcement.ends_at && (
                        <span className="ml-3">
                          Ends: {new Date(announcement.ends_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleActive(announcement.id, announcement.is_active)}
                      disabled={loading}
                    >
                      {announcement.is_active ? 'Deactivate' : 'Activate'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(announcement)}
                      disabled={loading}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(announcement.id)}
                      disabled={loading}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Edit Form */}
      {editing && (
        <Card>
          <CardHeader>
            <CardTitle>{editing === 'new' ? 'New Announcement' : 'Edit Announcement'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Title" htmlFor="title">
              <Input
                id="title"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="e.g., Holiday Hours, Special Promotion"
                required
              />
            </Field>

            <Field label="Message" htmlFor="body" hint="Optional additional details">
              <Textarea
                id="body"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                rows={3}
                placeholder="Optional message text..."
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Link URL" htmlFor="link_url" hint="Optional">
                <Input
                  id="link_url"
                  value={formData.link_url}
                  onChange={(e) => setFormData({ ...formData, link_url: e.target.value })}
                  placeholder="/services"
                />
              </Field>

              <Field label="Link Label" htmlFor="link_label" hint="Optional">
                <Input
                  id="link_label"
                  value={formData.link_label}
                  onChange={(e) => setFormData({ ...formData, link_label: e.target.value })}
                  placeholder="Learn More"
                />
              </Field>
            </div>

            {/* ── Template ─────────────────────────────────── */}
            <div className="border-t border-[var(--color-border)] pt-5">
              <p className="label-caps mb-1 text-[var(--color-accent)]">Template</p>
              <p className="mb-4 text-sm text-[var(--color-muted)]">
                A starting point for the colours. Override either one below if you want
                something specific.
              </p>

              <div className="grid gap-3 sm:grid-cols-3">
                {TEMPLATES.map((t) => {
                  const active = formData.variant === t.value
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() =>
                        setFormData({
                          ...formData,
                          variant: t.value,
                          // Switching template clears a stale custom colour,
                          // otherwise the swatch you picked silently wins and the
                          // template appears not to work.
                          background_color: '',
                          text_color: '',
                        })
                      }
                      aria-pressed={active}
                      className={cn(
                        'border p-3 text-left transition-colors',
                        active
                          ? 'border-[var(--color-foreground)]'
                          : 'border-[var(--color-border)] hover:border-[var(--color-muted)]'
                      )}
                    >
                      <span
                        className="mb-2 block h-8 w-full border border-black/10"
                        style={{ background: t.swatch, color: t.ink }}
                      >
                        <span className="label-caps px-2 leading-8">Aa</span>
                      </span>
                      <span className="text-sm">{t.label}</span>
                      <span className="block text-xs text-[var(--color-muted)]">{t.hint}</span>
                    </button>
                  )
                })}
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Background colour"
                  htmlFor="background_color"
                  hint="Leave blank to use the template."
                >
                  <div className="flex items-center gap-2">
                    <input
                      id="background_color"
                      type="color"
                      value={formData.background_color || '#efe7e1'}
                      onChange={(e) =>
                        setFormData({ ...formData, background_color: e.target.value })
                      }
                      className="h-11 w-14 shrink-0 cursor-pointer border border-[var(--color-border)] bg-transparent p-1"
                    />
                    <Input
                      aria-label="Background colour hex"
                      value={formData.background_color}
                      onChange={(e) =>
                        setFormData({ ...formData, background_color: e.target.value })
                      }
                      placeholder="#EFE7E1"
                      maxLength={7}
                    />
                    {formData.background_color && (
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, background_color: '' })}
                        className="label-caps shrink-0 px-2 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </Field>

                <Field
                  label="Text colour"
                  htmlFor="text_color"
                  hint="Leave blank to use the template."
                >
                  <div className="flex items-center gap-2">
                    <input
                      id="text_color"
                      type="color"
                      value={formData.text_color || '#2b2320'}
                      onChange={(e) => setFormData({ ...formData, text_color: e.target.value })}
                      className="h-11 w-14 shrink-0 cursor-pointer border border-[var(--color-border)] bg-transparent p-1"
                    />
                    <Input
                      aria-label="Text colour hex"
                      value={formData.text_color}
                      onChange={(e) => setFormData({ ...formData, text_color: e.target.value })}
                      placeholder="#2B2320"
                      maxLength={7}
                    />
                    {formData.text_color && (
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, text_color: '' })}
                        className="label-caps shrink-0 px-2 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </Field>
              </div>

              {contrastWarning && (
                <p className="mt-3 border-l-2 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-transparent dark:text-amber-300">
                  {contrastWarning}
                </p>
              )}

              {/* What it will actually look like, rather than two hex codes. */}
              <div className="mt-4">
                <p className="label-caps mb-2 text-[var(--color-muted)]">Preview</p>
                <div
                  className="border border-[var(--color-border)] p-4"
                  style={{
                    background: formData.background_color || preset.swatch,
                    color: formData.text_color || preset.ink,
                  }}
                >
                  <p className="text-sm font-medium">{formData.title || 'Your headline'}</p>
                  {formData.body && <p className="mt-1 text-sm opacity-90">{formData.body}</p>}
                  {formData.link_label && (
                    <p className="label-caps mt-2 underline underline-offset-4">
                      {formData.link_label}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Start Date" htmlFor="starts_at" hint="Optional">
                <Input
                  id="starts_at"
                  type="date"
                  value={formData.starts_at}
                  onChange={(e) => setFormData({ ...formData, starts_at: e.target.value })}
                />
              </Field>

              <Field label="End Date" htmlFor="ends_at" hint="Optional">
                <Input
                  id="ends_at"
                  type="date"
                  value={formData.ends_at}
                  onChange={(e) => setFormData({ ...formData, ends_at: e.target.value })}
                />
              </Field>
            </div>

            {/* ── How it looks ─────────────────────────────── */}
            <div className="border-t border-[var(--color-border)] pt-5">
              <p className="label-caps mb-4 text-[var(--color-accent)]">How it appears</p>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Format" htmlFor="display_style">
                  <Select
                    id="display_style"
                    value={formData.display_style}
                    onChange={(e) =>
                      setFormData({ ...formData, display_style: e.target.value as typeof formData.display_style })
                    }
                  >
                    <option value="banner">Banner — strip above the header</option>
                    <option value="modal">Modal — pop-up over the page</option>
                    <option value="corner">Corner card — bottom right</option>
                    <option value="inline">Inline — top of the page content</option>
                  </Select>
                </Field>

                <ImageField
                  label="Picture"
                  value={formData.image_url || null}
                  onChange={(url) => setFormData({ ...formData, image_url: url ?? '' })}
                  bucket="site"
                  folder="announcements"
                  aspect="wide"
                  hint="Optional. A thumbnail on a banner, full width on a modal or a card."
                />
              </div>

              {(formData.display_style === 'modal' || formData.display_style === 'corner') && (
                <Field
                  className="mt-4"
                  label="Delay before showing (seconds)"
                  htmlFor="delay_seconds"
                  hint="0 shows it immediately. A few seconds is far less jarring."
                >
                  <Input
                    id="delay_seconds"
                    type="number"
                    min={0}
                    max={60}
                    value={formData.delay_seconds}
                    onChange={(e) =>
                      setFormData({ ...formData, delay_seconds: Number(e.target.value) })
                    }
                  />
                </Field>
              )}

              <Field className="mt-4" label="If dismissed" htmlFor="dismiss_scope">
                <Select
                  id="dismiss_scope"
                  value={formData.dismiss_scope}
                  onChange={(e) =>
                    setFormData({ ...formData, dismiss_scope: e.target.value as typeof formData.dismiss_scope })
                  }
                >
                  <option value="session">Comes back on their next visit</option>
                  <option value="persist">Stays closed on that device</option>
                  <option value="never">Cannot be dismissed — shows every time</option>
                </Select>
              </Field>

              {formData.display_style === 'modal' && formData.dismiss_scope === 'never' && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  A modal always gets a close button — otherwise there is no way past it.
                  It will still reappear on every page view.
                </p>
              )}
            </div>

            {/* ── Who sees it, and where ───────────────────── */}
            <div className="border-t border-[var(--color-border)] pt-5">
              <p className="label-caps mb-4 text-[var(--color-accent)]">Who sees it</p>

              <Field label="Audience" htmlFor="audience_type">
                <Select
                  id="audience_type"
                  value={formData.audience_type}
                  onChange={(e) =>
                    setFormData({ ...formData, audience_type: e.target.value as typeof formData.audience_type })
                  }
                >
                  <option value="all">Everyone</option>
                  <option value="anonymous">Logged-out visitors only</option>
                  <option value="authenticated">Anyone signed in</option>
                  <option value="role">Specific roles…</option>
                </Select>
              </Field>

              {formData.audience_type === 'role' && (
                <fieldset className="mt-4">
                  <legend className="label-caps mb-2 text-[var(--color-muted)]">Roles</legend>
                  <div className="flex flex-wrap gap-2">
                    {(['client', 'provider', 'front_desk', 'manager', 'admin'] as const).map((r) => {
                      const on = formData.audience_roles.includes(r)
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() =>
                            setFormData({
                              ...formData,
                              audience_roles: on
                                ? formData.audience_roles.filter((x) => x !== r)
                                : [...formData.audience_roles, r],
                            })
                          }
                          className={
                            'border px-3 py-1.5 text-xs capitalize transition-colors ' +
                            (on
                              ? 'border-[var(--color-accent)] bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-transparent dark:text-[var(--color-accent)]'
                              : 'border-[var(--color-border)] text-[var(--color-muted)]')
                          }
                          aria-pressed={on}
                        >
                          {r.replace('_', ' ')}
                        </button>
                      )
                    })}
                  </div>
                  {formData.audience_roles.length === 0 && (
                    <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                      No roles picked — nobody will see this.
                    </p>
                  )}
                </fieldset>
              )}

              <Field
                className="mt-4"
                label="Pages"
                htmlFor="target_pages"
                hint="One path per line. Leave empty for every page. Use /account/* to cover a section."
              >
                <Textarea
                  id="target_pages"
                  rows={3}
                  value={formData.target_pages}
                  onChange={(e) => setFormData({ ...formData, target_pages: e.target.value })}
                  placeholder={'/\n/book\n/services/*'}
                />
              </Field>

              <Field
                className="mt-4"
                label="Priority"
                htmlFor="priority"
                hint="When several match the same spot, the highest number wins."
              >
                <Input
                  id="priority"
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: Number(e.target.value) })}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={formData.is_active}
                onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
              />
              <span>Active (show on site)</span>
            </label>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-3 border-t border-[var(--color-border)] pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={resetForm}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={loading}>
                {loading ? 'Saving...' : 'Save Announcement'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
