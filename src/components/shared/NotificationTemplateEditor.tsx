'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Textarea } from '@/components/ui/field'
import {
  KIND_CATEGORY,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  PLACEHOLDERS,
  type NotificationTemplate,
} from '@/types/notifications'

/**
 * The wording of one message, and a preview of what it turns into.
 *
 * The preview goes through `preview_notification_template` rather than being
 * re-implemented here. Substitution happens in SQL because that is where
 * sending happens; a second copy in TypeScript would eventually disagree with
 * it, and the place you would find out is a message that already went.
 */
export function NotificationTemplateEditor({
  template,
}: {
  template: NotificationTemplate
}) {
  const router = useRouter()
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [title, setTitle] = useState(template.title_template)
  const [body, setBody] = useState(template.body_template)
  const [link, setLink] = useState(template.link_template ?? '')
  const [opensThread, setOpensThread] = useState(template.opens_thread)
  const [active, setActive] = useState(template.is_active)

  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null)

  const isMarketing = KIND_CATEGORY[template.kind] === 'marketing'
  const dirty =
    title !== template.title_template ||
    body !== template.body_template ||
    (link || null) !== template.link_template ||
    opensThread !== template.opens_thread ||
    active !== template.is_active

  /** Drop a placeholder in at the cursor rather than making people type braces. */
  function insert(token: string) {
    const el = bodyRef.current
    const chip = `{{${token}}}`
    if (!el) {
      setBody((b) => `${b}${chip}`)
      return
    }
    const start = el.selectionStart ?? body.length
    const end = el.selectionEnd ?? body.length
    const next = `${body.slice(0, start)}${chip}${body.slice(end)}`
    setBody(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + chip.length, start + chip.length)
    })
  }

  async function showPreview() {
    setBusy(true)
    const { data, error } = await createClient().rpc('preview_notification_template', {
      p_title: title,
      p_body: body,
      p_link: link || null,
    })
    setBusy(false)

    if (error) {
      toast.error('Could not render the preview.')
      return
    }

    const result = data as unknown as { title: string; body: string }
    setPreview({ title: result.title, body: result.body })
  }

  async function save() {
    if (!title.trim() || !body.trim()) {
      toast.error('A message needs a heading and something to say.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('notification_templates')
      .update({
        title_template: title,
        body_template: body,
        link_template: link.trim() || null,
        opens_thread: opensThread,
        is_active: active,
      })
      .eq('id', template.id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not save that.')
      return
    }

    toast.success('Saved.')
    router.refresh()
  }

  return (
    <div className="py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-prose">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {KIND_LABELS[template.kind]}
            {isMarketing ? (
              <Badge tone="warning" size="sm">
                Marketing
              </Badge>
            ) : (
              <Badge tone="info" size="sm">
                Transactional
              </Badge>
            )}
            {!template.is_active && (
              <Badge tone="danger" size="sm">
                Off
              </Badge>
            )}
          </p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {KIND_DESCRIPTIONS[template.kind]}
          </p>
        </div>

        <Button variant="subtle" size="sm" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Edit wording'}
        </Button>
      </div>

      {!open && (
        <p className="mt-3 max-w-prose whitespace-pre-wrap text-xs text-[var(--color-muted)]">
          <span className="text-[var(--color-foreground)]">{template.title_template}</span>
          {'\n'}
          {template.body_template}
        </p>
      )}

      {open && (
        <div className="mt-5 space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          {isMarketing ? (
            <p className="border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-3 text-sm text-[var(--color-muted)] dark:bg-[var(--color-background)]">
              This one is marketing. It is only ever sent to clients who have opted
              in, and that is enforced when it sends — rewording it cannot change
              that.
            </p>
          ) : (
            <p className="border-l-2 border-[var(--color-border)] p-3 text-sm text-[var(--color-muted)]">
              This one is transactional: it is about something the client has already
              booked or asked for, so it goes out whether or not they take marketing.
              Switching it off stops it entirely.
            </p>
          )}

          <Field label="Heading" htmlFor={`title_${template.id}`}>
            <Input
              id={`title_${template.id}`}
              value={title}
              maxLength={140}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field
            label="Message"
            htmlFor={`body_${template.id}`}
            hint="Anything in double braces is filled in when it sends. A word we do not recognise is left exactly as you typed it."
          >
            <Textarea
              id={`body_${template.id}`}
              ref={bodyRef}
              rows={7}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>

          <div>
            <p className="label-caps mb-2 text-[var(--color-muted)]">Insert</p>
            <div className="flex flex-wrap gap-1.5">
              {PLACEHOLDERS.map((p) => (
                <button
                  key={p.token}
                  type="button"
                  title={p.describes}
                  onClick={() => insert(p.token)}
                  className="border border-[var(--color-border)] px-2 py-1 text-[0.6875rem] text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-foreground)]"
                >
                  {p.token}
                </button>
              ))}
            </div>
          </div>

          <Field
            label="Where it links"
            htmlFor={`link_${template.id}`}
            hint="Optional. A path on this site, e.g. /account/appointments."
          >
            <Input
              id={`link_${template.id}`}
              value={link}
              maxLength={200}
              onChange={(e) => setLink(e.target.value)}
              placeholder="/account/appointments"
            />
          </Field>

          <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={opensThread}
                onChange={(e) => setOpensThread(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                They can reply
                <span className="block text-xs text-[var(--color-muted)]">
                  Opens a conversation in your inbox alongside the notification. Worth
                  it when you expect an answer; every reminder doing it would fill the
                  inbox with threads nobody reads.
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                Send this
                <span className="block text-xs text-[var(--color-muted)]">
                  {isMarketing
                    ? 'Off means nobody is nudged, opted in or not.'
                    : 'Off means clients stop being told about this entirely — including the ones who need to know.'}
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap gap-3 border-t border-[var(--color-border)] pt-5">
            <Button size="sm" onClick={save} disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="subtle" size="sm" onClick={showPreview} disabled={busy}>
              Preview
            </Button>
          </div>

          {preview && (
            <div className="border border-[var(--color-border)] bg-[var(--color-linen)] p-4 dark:bg-[var(--color-background)]">
              <p className="label-caps text-[var(--color-muted)]">
                What Marisol would see
              </p>
              <p className="mt-3 text-sm">{preview.title}</p>
              <p className="mt-1.5 whitespace-pre-wrap text-xs text-[var(--color-muted)]">
                {preview.body}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
