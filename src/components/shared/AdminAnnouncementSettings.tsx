'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Textarea, Field, Select } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase/client'
import { Plus, Trash2, Edit2 } from 'lucide-react'

interface Announcement {
  id: number
  title: string
  body: string | null
  link_url: string | null
  link_label: string | null
  variant: 'info' | 'promo' | 'urgent'
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
  created_at: string
}

interface Props {
  announcements: Announcement[]
}

export function AdminAnnouncementSettings({ announcements: initialAnnouncements }: Props) {
  const router = useRouter()
  const [announcements, setAnnouncements] = useState(initialAnnouncements)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [formData, setFormData] = useState({
    title: '',
    body: '',
    link_url: '',
    link_label: '',
    variant: 'info' as 'info' | 'promo' | 'urgent',
    starts_at: '',
    ends_at: '',
    is_active: true,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resetForm = () => {
    setFormData({
      title: '',
      body: '',
      link_url: '',
      link_label: '',
      variant: 'info',
      starts_at: '',
      ends_at: '',
      is_active: true,
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
      starts_at: announcement.starts_at ? announcement.starts_at.split('T')[0] : '',
      ends_at: announcement.ends_at ? announcement.ends_at.split('T')[0] : '',
      is_active: announcement.is_active,
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

      const data: any = {
        title: formData.title.trim(),
        body: formData.body.trim() || null,
        link_url: formData.link_url.trim() || null,
        link_label: formData.link_label.trim() || null,
        variant: formData.variant,
        starts_at: formData.starts_at ? new Date(formData.starts_at).toISOString() : null,
        ends_at: formData.ends_at ? new Date(formData.ends_at).toISOString() : null,
        is_active: formData.is_active,
      }

      if (editing === 'new') {
        const { error: insertError } = await supabase
          .from('announcements')
          .insert(data)

        if (insertError) throw insertError
      } else {
        const { error: updateError } = await supabase
          .from('announcements')
          .update(data)
          .eq('id', editing)

        if (updateError) throw updateError
      }

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

      setAnnouncements(announcements.filter(a => a.id !== id))
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

            <Field label="Variant" htmlFor="variant">
              <Select
                id="variant"
                value={formData.variant}
                onChange={(e) => setFormData({ ...formData, variant: e.target.value as any })}
              >
                <option value="info">Info (Blue)</option>
                <option value="promo">Promo (Green)</option>
                <option value="urgent">Urgent (Red)</option>
              </Select>
            </Field>

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
