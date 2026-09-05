# What is worth building next

**Date:** 2026-09-06. A survey, not a plan — the plans live beside this file.

Sizes are rough: **S** is an afternoon, **M** a day or two, **L** longer than
that. Every item says why it matters, because a backlog of things that would be
nice is a backlog nobody picks from.

---

## 1. The dashboard is missing two things the CLI has

Found by listing both surfaces side by side. These are not polish — they are
capabilities that exist, that people rely on, and that the web UI does not admit
exist.

### Backups and restore — **absent entirely** · M

`fleet backup`, `fleet backups`, `fleet restore` have no page, no panel, no
mention. The dashboard's only matches for "backup" are in account deletion.

So the one view people keep open cannot answer *do I have a backup of this
database, and how old is it* — which is the question you ask at exactly the
moment you are least able to open a terminal calmly.

A page listing backups per service, newest first, with size and age, and a
restore that makes you type the service name. Restore overwrites a volume, so it
belongs behind the same friction `fleet rm` has.

### The secret store — **absent** · S

`fleet secrets ls/set/rm` manages the fleet's credentials. The dashboard shows
nothing. A page listing key names per service — never values, which the CLI is
already careful about — and letting one be removed. Setting a value from a
browser is worth thinking about before building; listing what exists is not.

---

## 2. Dashboard UX

### A global command palette · M

Fourteen pages and growing. `⌘K` → jump to a service, a node, a deployment; run
`diagnose`; open logs. It is the difference between a dashboard you navigate and
one you operate.

### Deployment progress that survives a reload · S

`DeployProgress` exists and is good. Reload during a deploy and it is gone — the
deploy continues, the view does not. The progress rows live in the database
already; this is a fetch, not a feature.

### Empty states that know why they are empty · S

"No services in this fleet" is right on a new fleet and wrong when Docker is
down on the only node — which is the fleet's state as this is written. The
Doctor page knows the difference. The empty state should ask it.

### One place that answers "is anything wrong" · M

Overview shows what exists. Doctor shows what is broken. Neither shows *what
changed since you last looked*, which is the actual question on opening a
dashboard. A digest — deploys, failures, nodes that came and went — since your
last visit.

### Dark and light both, properly · S

There are tokens and a `prefers-color-scheme` block. Nobody has checked every
page in both. Worth an hour with a checklist rather than a rewrite.

---

## 3. CLI

### `fleet watch` · M

A live pane: services, nodes, deploys, as they change. The reverse tunnel
already carries everything it needs. Today watching a deploy means running
`fleet deployments` repeatedly.

### `fleet fix --dry-run` · S

Show the proposal and stop. `fleet fix` currently commits you to a prompt before
you have seen what it wants; a dry run is how people learn to trust it.

### `fleet logs --since` across a rollout · S

Logs come from the last heartbeat, so they are the current container's. After a
rollout the interesting lines belong to the container that just died. The
deployment history has the id; the tail does not follow it.

### `fleet diff` · M

What the manifest says against what the fleet is running. `fleet apply` already
computes it internally and reports created/updated. Surfacing it as a command
answers "what would `up` actually do" without doing it.

### Exit codes for everything · S

`0/1/2/3/4` are documented and only some commands use the specific ones. A
script that can distinguish "no eligible node" from "health check failed" can
react; one that sees `1` can only stop.

---

## 4. The manifest generator

Covered in detail in `plan-a-manifest-that-runs.md`. The short version:

- **The language table** · M — node, python, go, rust are known. .NET, Ruby,
  Java, PHP, Elixir, Bun, Deno and static sites are not. The voting app's own
  worker is .NET and falls through. Mechanical, testable one language at a time,
  and probably the highest total return on this whole list.
- **Name databases from the source** · S — `init` calls a database whatever the
  compose file called it, and the application has already decided what that
  hostname is. The review can now *fix* this; not creating it is better.
- **A test corpus** · M — a dozen public repositories, `init --ai` then
  `apply --dry-run`, and one number: how many validate untouched. Every
  improvement above is guesswork without it.

---

## 5. The AI loop

### Let `fleet fix` watch · L

The pieces exist: diagnose, propose, apply, deploy, verify, revert. What does
not exist is anything that notices a failure without being asked. This is the
one item on the list that deserves its own argument before it is built — see
`plan-the-closed-loop.md` §4.

### Cache a diagnosis by fault signature · S

`explain` caches; `diagnose` does not. Two people asking why the same service is
down in the same minute pay twice.

### Show the investigation as it happens · M

Both the CLI and the dashboard wait, then print. The lookups are known one at a
time and could stream. A twenty-second wait showing "deployments · containers ·
logs" reads as work; the same twenty seconds blank reads as a hang.

---

## 6. Platform

### The full test suite has never been watched green · S

36 files, run serially. Individual files pass. Nobody has seen all of them pass
together, so "the tests pass" is currently a claim rather than a fact.

### `--test-isolation=none` · S

Measured 2.6× on a five-file sample. One flag, and it makes the item above
cheap enough that people actually do it.

### Agent release is manual · M

Cross-compile locally, tar, scp, and remember `COPYFILE_DISABLE=1` or macOS
smuggles AppleDouble files into the release. Every step of that is a thing to
forget. A `make release` target that does all of it is an afternoon.

### Nothing tests the agent against a real Docker · L

The Go tests are unit tests. Everything learned about health probing, drift and
reaping came from deploying and watching. One integration test that starts a
container and asserts the agent reports it would have caught three of this
week's bugs.

---

## What to do next

**The language table**, and it is not close. It is the only item that changes
whether Fleet works for a repository somebody arrives with, rather than how
pleasant it is once it already works. Everything else on this list improves a
system that is already running; that one decides whether it starts.

After it, in order:

1. **The test corpus** — because without it, the language table's success is an
   opinion.
2. **Backups in the dashboard** — the largest gap between what Fleet can do and
   what it appears to do, and it is about data.
3. **`--test-isolation=none` and one green run** — cheap, and it converts a
   claim into a fact.

Least urgent despite being most interesting: **the watching fixer**. It needs
the argument in `plan-the-closed-loop.md` §4 settled first, and that is a
decision rather than a build.
