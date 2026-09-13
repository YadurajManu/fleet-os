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

/** Overview page skeleton — summary cards, mesh, placement map, activity feed. */
export function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-6">
      {/* summary cards */}
      <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="bg-[var(--color-ink-950)] px-5 py-4">
            <Bar className="h-2 w-1/2" />
            <Bar className="mt-3 h-5 w-1/3" />
          </div>
        ))}
      </div>
      {/* mesh placeholder */}
      <div className="rounded border border-[var(--color-line)] p-5">
        <Bar className="h-4 w-24" />
        <div className="mt-4 flex items-center gap-6">
          <Bar className="h-20 w-20 rounded-full" />
          <div className="flex-1 space-y-2">
            <Bar className="h-3 w-3/4" />
            <Bar className="h-3 w-1/2" />
          </div>
        </div>
      </div>
      {/* placement map + activity */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="rounded border border-[var(--color-line)] p-5">
          <Bar className="h-4 w-28" />
          <div className="mt-4 grid gap-px bg-[var(--color-line)] sm:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="bg-[var(--color-ink-950)] p-5 space-y-3">
                <Bar className="h-3 w-1/2" />
                <Bar className="h-2 w-1/3" />
                <Bar className="h-1.5 w-full" />
                <Bar className="h-1.5 w-full" />
                <div className="flex gap-1.5">
                  <Bar className="h-5 w-14" />
                  <Bar className="h-5 w-12" />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded border border-[var(--color-line)] p-5">
          <Bar className="h-4 w-28" />
          <div className="mt-4 space-y-0 divide-y divide-[var(--color-line)]">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="px-0 py-3 space-y-1.5">
                <div className="flex justify-between">
                  <Bar className="h-3 w-1/3" />
                  <Bar className="h-3 w-12" />
                </div>
                <Bar className="h-2 w-2/3" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Node detail page skeleton — header, gauges, charts. */
export function NodeDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-6">
      <Bar className="h-3 w-16" />
      <div className="flex flex-wrap items-center gap-3">
        <Bar className="h-7 w-40" />
        <Bar className="h-5 w-16 rounded-full" />
        <Bar className="h-3 w-48" />
      </div>
      {/* gauge cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="rounded border border-[var(--color-line)] p-4 space-y-2">
            <Bar className="h-2 w-12" />
            <Bar className="h-8 w-20" />
            <Bar className="h-1.5 w-full" />
          </div>
        ))}
      </div>
      {/* chart */}
      <div className="rounded border border-[var(--color-line)] p-5">
        <div className="flex justify-between">
          <Bar className="h-4 w-24" />
          <Bar className="h-3 w-32" />
        </div>
        <div className="mt-4 flex items-end gap-px h-32">
          {Array.from({ length: 40 }, (_, i) => (
            <div key={i} className="flex-1 flex flex-col justify-end">
              <Bar className="rounded-t" {...{ style: { height: `${20 + Math.sin(i * 0.3) * 15 + Math.random() * 10}%` } }} />
            </div>
          ))}
        </div>
      </div>
      {/* services list */}
      <div className="rounded border border-[var(--color-line)]">
        <div className="px-4 py-3 border-b border-[var(--color-line)]">
          <Bar className="h-4 w-28" />
        </div>
        <TableSkeleton rows={3} columns={[30, 20, 20, 15, 15]} />
      </div>
    </div>
  )
}

/** Doctor page skeleton — health checks. */
export function DoctorSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="space-y-6">
      <div>
        <Bar className="h-6 w-28" />
        <Bar className="mt-2 h-3 w-80" />
      </div>
      <div className="rounded border border-[var(--color-line)] divide-y divide-[var(--color-line)]">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="px-5 py-4 space-y-2">
            <div className="flex items-center gap-2">
              <Bar className="h-3 w-3 rounded-full" />
              <Bar className="h-3 w-1/3" />
            </div>
            <Bar className="h-2.5 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  )
}
