/**
 * Placeholders shaped like the thing that is coming.
 *
 * What a loading page used to show was either nothing at all or, worse, its
 * empty state — "No services yet" while the request was still in flight. That
 * is a statement about the fleet, and it was false: a reader who glances at the
 * wrong moment is told they have no services when they have six.
 *
 * A skeleton says something true and useful instead. It is not decoration — the
 * point is that the rows are the height of real rows and the blocks the width
 * of real columns, so the layout does not jump when the data lands, and the
 * shape tells you what to expect before it exists.
 *
 * With `usePoll` remembering its last answer these appear far less often, which
 * is right: a skeleton is for when there is genuinely nothing to show, and that
 * is now only a first visit.
 */

/** One shimmering block. Width and height are the caller's business. */
export function Bar({ className = '' }: { className?: string }) {
  return (
    <div
      className={`shimmer rounded-[3px] bg-[var(--color-line)]/40 ${className}`}
      // Announced as busy rather than read out. A screen reader should hear
      // "loading", not the geometry of six grey rectangles.
      aria-hidden="true"
    />
  )
}

/**
 * A stand-in for a table, sized to the table that is coming.
 *
 * `rows` should match what the page usually holds — close enough that the
 * content lands roughly where the skeleton was, rather than shifting the page
 * under a reader who has already started looking.
 */
export function TableSkeleton({
  rows = 4,
  columns = [40, 20, 20, 20],
}: {
  rows?: number
  /** Column widths as percentages, so it matches the real table's proportions. */
  columns?: number[]
}) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-[var(--color-line)]">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex items-center gap-4 px-4 py-3">
          {columns.map((width, c) => (
            <Bar
              key={c}
              className="h-3"
              // Inline, because the widths are data rather than design: a page
              // passes the proportions its own table uses.
              {...{ style: { width: `${width}%` } }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** A stand-in for a row of summary cards. */
export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-[4px] border border-[var(--color-line)] p-4">
          <Bar className="h-2 w-1/2" />
          <Bar className="mt-3 h-5 w-3/4" />
        </div>
      ))}
    </div>
  )
}

/** A stand-in for a block of prose or a log tail. */
export function LinesSkeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-2">
      {Array.from({ length: lines }, (_, i) => (
        <Bar
          key={i}
          className="h-3"
          // Ragged, like text. A stack of identical bars reads as a table, and
          // this is standing in for something that is not one.
          {...{ style: { width: `${90 - (i % 3) * 18}%` } }}
        />
      ))}
    </div>
  )
}
