/**
 * The arithmetic behind a drag-to-reorder list, kept apart from the DOM so it
 * can be tested. SortableList measures the rows once when a drag starts and
 * asks these where the row would land; the database is told the result as a
 * list of ids (reorder_catalog, migration 093) and decides nothing but the
 * numbers.
 */

/** A copy of `list` with the item at `from` moved to `to`. Out of range is a no-op copy. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Where the dragged row lands: the number of other rows whose middle is above
 * the dragged row's middle. That count is the dragged row's index once it is
 * taken out and put back.
 *
 * `mids` are the rows' vertical middles measured when the drag began, `from`
 * is the dragged row's index, `dy` how far the pointer has travelled since.
 */
export function dropIndex(mids: readonly number[], from: number, dy: number): number {
  if (from < 0 || from >= mids.length) return from
  const centre = mids[from] + dy
  let above = 0
  for (let i = 0; i < mids.length; i++) {
    if (i !== from && mids[i] < centre) above++
  }
  return above
}

/**
 * How far a row that is not being dragged should slide to make room, in
 * multiples of the dragged row's height: -1 up, 1 down, 0 stay.
 */
export function shiftFor(index: number, from: number, over: number): -1 | 0 | 1 {
  if (index === from) return 0
  if (from < over && index > from && index <= over) return -1
  if (from > over && index >= over && index < from) return 1
  return 0
}
