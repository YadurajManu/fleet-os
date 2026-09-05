# A dashboard that remembers

**Status:** proposal, then built. 2026-09-06
**Scope:** `dashboard/` only. No API changes, no new dependencies.

Two complaints, one cause and one omission:

1. Leave a page and come back, and it has forgotten everything — the search you
   typed, the filter you set — and reloads from scratch.
2. While it reloads there is nothing to look at.

---

## 1. Why it forgets

`usePoll` in `src/lib/auth.tsx` is the whole data layer, and it holds its state
in the component:

```ts
const [data, setData] = useState<T | null>(null)
const [loading, setLoading] = useState(true)
```

Navigating away unmounts the page. `data` goes back to `null` and `loading`
back to `true`, so returning shows an empty screen and starts a fresh request —
for data that was correct four seconds ago and is almost certainly still
correct.

The search box and filters have the same shape:

```ts
const [search, setSearch] = useState('')
const [filterStatus, setFilterStatus] = useState<FilterStatus>('ALL')
```

Component state, gone with the component.

There is no query library — three dependencies, `react`, `react-dom`,
`react-router-dom` — and this plan does not add one. Both problems are a few
dozen lines each, and a cache whose behaviour we chose deliberately is worth
more here than one whose defaults we would spend longer configuring.

---

## 2. What to build

### A. Stale-while-revalidate in `usePoll`

A module-level cache keyed by the dependency list. On mount, if there is a
cached value, show it immediately with `loading: false` and revalidate in the
background. On a fresh key, behave exactly as now.

The screen stops flashing empty, and a return to a page you were on ten seconds
ago is instant. The data is still refreshed — it just is not the only thing on
screen while that happens.

Two details that matter:

- **A cached value can be stale enough to be wrong.** Keep the time it was
  fetched, and if it is older than a minute treat it as absent — for a fleet
  dashboard, a minute-old view of what is running is misleading rather than
  merely late.
- **The cache is per key, and the key must include the fleet.** Showing one
  fleet's services under another's name because the dependency list only had a
  page name would be worse than any reload.

### B. Search and filters in the URL

`useSearchParams`, which `react-router-dom` already provides and two pages
already use.

Better than lifting the state into a store, for reasons that have nothing to do
with implementation cost: a filtered view becomes a link somebody can send, the
back button does what it looks like it does, and a reload keeps the view. State
that describes *what you are looking at* belongs in the address bar.

Not everything moves. A half-typed manifest in the editor, an open confirmation
dialog, which row is expanded — none of that is worth putting in a URL, and
some of it would be actively wrong to restore.

### C. Skeletons

Today a loading page renders nothing, or an empty-state that reads like "you
have no services" while the request is in flight — the worst possible message,
because it is a statement about the fleet and it is false.

Replace with placeholders shaped like the content: rows the height of real rows,
blocks the width of real columns. A skeleton is not decoration; it says *this
will be a table of six services* before the table exists, so the layout does not
jump when it arrives.

With A in place these appear far less often, which is the point — a skeleton is
what you show when you genuinely have nothing, and after A that is only a first
visit.

---

## 3. Order

1. **`usePoll` cache** — one file, and it fixes the reload on every page at once.
2. **Skeletons** — a small component plus its use on the four list pages.
3. **URL state** — per page, starting with Services, which has the most.

---

## 4. How we will know

- Navigate Services → Nodes → Services: **no spinner, no empty flash**, and the
  search text still there.
- Type a filter, copy the URL, open it in a new tab: **the same view**.
- A first visit still shows skeletons rather than an empty page.
- Nothing shows a cached view older than a minute.

---

## 5. What this deliberately avoids

**Adding a query library.** It would bring a cache, and also a mental model,
a devtools panel and a set of defaults to learn. The whole data layer here is
forty lines; replacing it with a dependency to fix a fifteen-line gap is a poor
trade, and this project has to be legible to whoever picks it up next.

**Caching mutations or making the cache clever.** It holds GET responses for a
minute. Every write already calls `refetch()`, and that stays exactly as it is.
