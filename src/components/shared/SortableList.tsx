'use client'

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { revalidatePublic } from '@/lib/revalidate-public'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { dropIndex, moveItem, shiftFor } from '@/lib/reorder'
import { cn } from '@/lib/utils'

/** The lists reorder_catalog (migration 093) knows how to renumber. */
export type ReorderKind = 'services' | 'service_categories' | 'memberships'

/**
 * One row. `label` names it to a screen reader ("Move Glow up"); `content` is
 * what the row shows when the caller does not lay it out itself, which is how
 * a Server Component hands rows over (it cannot pass a render function).
 */
export interface SortableItem {
  id: number
  label: string
  content?: ReactNode
}

/** What a drag needs to remember between pointer events. Never read in render. */
interface DragGeometry {
  pointerId: number
  startY: number
  from: number
  over: number
  mids: number[]
}

/**
 * A list whose order a manager can change: drag the grip, or press Move up /
 * Move down.
 *
 * The drag is Pointer Events, not HTML5 drag and drop, because the counter is
 * an iPad and iOS Safari does not start an HTML5 drag from a finger. The grip
 * captures the pointer and has `touch-action: none`, so a finger on it moves
 * the row instead of scrolling the page; everywhere else on the row scrolls
 * and taps as it always did.
 *
 * The rows are measured once when a drag starts. The dragged row follows the
 * pointer, the rows it passes slide out of its way, and letting go saves the
 * whole list's order in one call. The new order shows at once; if the save is
 * refused it snaps back and says so, and on success the page is refreshed so
 * every list reading sort_order agrees.
 *
 * The browser decides only the order. Who may change it is the database's
 * call (is_manager() inside reorder_catalog); `canManage` only decides whether
 * the grip and the buttons are drawn.
 */
export function SortableList<T extends SortableItem>({
  items,
  kind,
  canManage,
  disabled = false,
  disabledReason,
  className,
  itemClassName,
  draggingClassName = 'bg-[var(--color-background)] shadow-lg',
  children,
}: {
  items: T[]
  kind: ReorderKind
  /** Draw the controls at all. RLS is the guard; this only hides buttons. */
  canManage: boolean
  /** Draw the controls but leave them inert, e.g. while a search narrows the list. */
  disabled?: boolean
  /** Said on the inert controls, so it is clear why they do nothing. */
  disabledReason?: string
  className?: string
  itemClassName?: string
  /** How the row under the finger is lifted off the list. */
  draggingClassName?: string
  /**
   * Lay a row out yourself and put `controls` where the grip belongs (at the
   * left). Without it the controls sit left of `item.content`.
   */
  children?: (item: T, controls: ReactNode) => ReactNode
}) {
  const router = useRouter()

  // The optimistic order, remembered against the list it was made from. When
  // the server sends a different list (the refresh after a save, or anybody
  // else's edit) the basis no longer matches and the server's order wins,
  // with no effect needed to notice.
  const basis = items.map((i) => i.id).join(',')
  const [pending, setPending] = useState<{ basis: string; ids: number[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<{ from: number; over: number; dy: number; step: number } | null>(
    null
  )
  const [announcement, setAnnouncement] = useState('')

  const rows = useRef(new Map<number, HTMLLIElement>())
  const geometry = useRef<DragGeometry | null>(null)

  const order: T[] = (() => {
    if (!pending || pending.basis !== basis) return items
    const byId = new Map(items.map((i) => [i.id, i]))
    const placed = pending.ids.flatMap((id) => {
      const item = byId.get(id)
      return item ? [item] : []
    })
    const placedIds = new Set(placed.map((i) => i.id))
    return [...placed, ...items.filter((i) => !placedIds.has(i.id))]
  })()

  const inert = disabled || busy

  async function commit(next: T[], moved: T, to: number) {
    const ids = next.map((i) => i.id)
    setPending({ basis, ids })
    setAnnouncement(`${moved.label} moved to position ${to + 1} of ${next.length}.`)
    setBusy(true)
    const { error } = await createClient().rpc('reorder_catalog', { p_kind: kind, p_ids: ids })
    setBusy(false)
    if (error) {
      setPending(null)
      setAnnouncement('The new order was not saved.')
      toast.error(
        error.code === '42501'
          ? 'Only a manager can change the order.'
          : 'Could not save the new order. It is back the way it was.'
      )
      return
    }
    if (kind !== 'memberships') void revalidatePublic()
    router.refresh()
  }

  function moveBy(index: number, by: -1 | 1) {
    const to = index + by
    if (inert || to < 0 || to >= order.length) return
    void commit(moveItem(order, index, to), order[index], to)
  }

  function onPointerDown(e: ReactPointerEvent<HTMLElement>, index: number) {
    // Primary button only for a mouse; a finger or a pen always reports 0.
    if (inert || geometry.current || e.button !== 0) return
    const rects = order.map((item) => rows.current.get(item.id)?.getBoundingClientRect())
    if (rects.some((r) => !r)) return
    const boxes = rects as DOMRect[]

    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)

    // How far a neighbour slides to make room: the dragged row's height plus
    // whatever gap the list puts between rows.
    const self = boxes[index]
    const gap =
      index + 1 < boxes.length
        ? boxes[index + 1].top - self.bottom
        : index > 0
          ? self.top - boxes[index - 1].bottom
          : 0

    geometry.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      from: index,
      over: index,
      mids: boxes.map((r) => r.top + r.height / 2),
    }
    setDrag({ from: index, over: index, dy: 0, step: self.height + Math.max(gap, 0) })
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const g = geometry.current
    if (!g || e.pointerId !== g.pointerId) return
    const dy = e.clientY - g.startY
    const over = dropIndex(g.mids, g.from, dy)
    g.over = over
    setDrag((d) => (d ? { ...d, dy, over } : d))
  }

  function finish(e: ReactPointerEvent<HTMLElement>, save: boolean) {
    const g = geometry.current
    if (!g || e.pointerId !== g.pointerId) return
    geometry.current = null
    setDrag(null)
    if (save && g.over !== g.from) {
      void commit(moveItem(order, g.from, g.over), order[g.from], g.over)
    }
  }

  const controlClass =
    'flex items-center justify-center text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)] disabled:pointer-events-none disabled:opacity-30'

  return (
    <>
      <ul className={className}>
        {order.map((item, index) => {
          const dragging = drag?.from === index
          const shift = drag ? shiftFor(index, drag.from, drag.over) : 0

          const controls = canManage ? (
            <div
              className="flex shrink-0 items-center gap-0.5 self-center"
              title={disabled ? disabledReason : undefined}
            >
              {/* Pointer only. Keyboard and screen-reader users have the two
                  buttons beside it, so the grip stays out of the tab order. */}
              <span
                aria-hidden
                data-ui="button"
                onPointerDown={(e) => onPointerDown(e, index)}
                onPointerMove={onPointerMove}
                onPointerUp={(e) => finish(e, true)}
                onPointerCancel={(e) => finish(e, false)}
                onLostPointerCapture={(e) => finish(e, false)}
                className={cn(
                  controlClass,
                  'h-11 w-8 touch-none select-none [-webkit-touch-callout:none]',
                  inert ? 'cursor-not-allowed opacity-30' : dragging ? 'cursor-grabbing' : 'cursor-grab'
                )}
              >
                <GripVertical className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <span className="flex flex-col">
                <button
                  type="button"
                  data-ui="button"
                  onClick={() => moveBy(index, -1)}
                  disabled={inert || index === 0}
                  aria-label={`Move ${item.label} up`}
                  className={cn(controlClass, 'h-6 w-7')}
                >
                  <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                </button>
                <button
                  type="button"
                  data-ui="button"
                  onClick={() => moveBy(index, 1)}
                  disabled={inert || index === order.length - 1}
                  aria-label={`Move ${item.label} down`}
                  className={cn(controlClass, 'h-6 w-7')}
                >
                  <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                </button>
              </span>
            </div>
          ) : null

          return (
            <li
              key={item.id}
              ref={(el) => {
                if (el) rows.current.set(item.id, el)
                else rows.current.delete(item.id)
              }}
              className={cn(
                itemClassName,
                drag && 'relative',
                dragging
                  ? cn('z-10', draggingClassName)
                  : drag && 'transition-transform duration-150 ease-out'
              )}
              style={
                drag
                  ? {
                      transform: dragging
                        ? `translateY(${drag.dy}px)`
                        : shift !== 0
                          ? `translateY(${shift * drag.step}px)`
                          : undefined,
                    }
                  : undefined
              }
            >
              {children ? (
                children(item, controls)
              ) : (
                <div className="flex items-start gap-3">
                  {controls}
                  <div className="min-w-0 flex-1">{item.content}</div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </>
  )
}
