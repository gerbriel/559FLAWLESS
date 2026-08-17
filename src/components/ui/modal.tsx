'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The dialog shell, once.
 *
 * Thirteen components had their own copy of it and two different bugs between
 * them, both of which showed up as "the modal is cut off":
 *
 *   - `flex items-center` on a scrolling overlay. A flex item taller than its
 *     container overflows in BOTH directions, and the half above the scroll
 *     origin is unreachable — the browser will not scroll up past zero. So the
 *     top of a long form, which is where its title and first fields are, simply
 *     could not be got at. This is the one people hit on the service editor.
 *   - No overflow rule at all. Six of the smaller dialogs centred their panel
 *     and left it at that, so anything taller than the window was lost outright.
 *
 * The fix is not "add overflow-y-auto to the overlay". A dialog should not make
 * the page behind it scroll; it should be at most as tall as the window and
 * scroll INSIDE itself, with the title and the buttons staying put — you can
 * always see what you are editing and always reach Save. So the panel is capped
 * at the viewport (`dvh`, so a phone's collapsing toolbar does not clip it), and
 * only the body between header and footer scrolls.
 *
 * `min-h-0` on that body is load-bearing and looks like nothing: a flex child's
 * default `min-height:auto` refuses to shrink below its content, which silently
 * defeats the cap and puts the overflow back on the page. `my-auto` is what
 * centres a short dialog — margin, not `items-center`, because auto margins
 * centre without ever pushing content out of reach.
 *
 * Escape closes it, the backdrop closes it, and the page behind is locked
 * against scrolling while it is open. All three used to be per-file decisions
 * and only AppointmentModal had made any of them.
 *
 * `busy` is the one piece of caller state the shell needs: mid-save, neither
 * the backdrop nor Escape nor the close button should be able to abandon a
 * write that is already in flight.
 */

const WIDTHS = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const

export function Modal({
  label,
  title,
  onClose,
  busy = false,
  onSubmit,
  footer,
  width = 'lg',
  bodyClassName,
  children,
}: {
  /** Accessible name for the dialog. Required — a dialog with no name is a box. */
  label: string
  /** Rendered in the pinned header. Omit for a dialog that supplies its own. */
  title?: React.ReactNode
  onClose: () => void
  /** While true the dialog cannot be dismissed by any route. */
  busy?: boolean
  /** Given, the panel is a <form> so a submit button in `footer` works. */
  onSubmit?: (e: React.FormEvent) => void
  /** Pinned below the scrolling body — the place for Save and Cancel. */
  footer?: React.ReactNode
  width?: keyof typeof WIDTHS
  bodyClassName?: string
  children: React.ReactNode
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    // Locking the page behind is what stops a scroll gesture over the backdrop
    // from moving the page instead of the dialog.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [busy, onClose])

  const Panel = onSubmit ? 'form' : 'div'

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={() => !busy && onClose()}
    >
      <Panel
        onSubmit={onSubmit}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        data-ui="panel"
        className={cn(
          'my-auto flex max-h-[calc(100dvh-2rem)] w-full flex-col border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl',
          WIDTHS[width]
        )}
      >
        <div className="flex items-start gap-3 border-b border-[var(--color-border)] px-6 py-5 sm:px-8">
          {title ? <h2 className="display min-w-0 flex-1 text-2xl">{title}</h2> : <div className="flex-1" />}
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            data-ui="button"
            className="-mr-3 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)] disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.5} />
          </button>
        </div>

        <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8', bodyClassName)}>
          {children}
        </div>

        {footer && (
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] px-6 py-4 sm:px-8">
            {footer}
          </div>
        )}
      </Panel>
    </div>
  )
}
