# The closed loop — where we are, and what is left

**Status:** assessment and proposal. Nothing here is built.
**Date:** 2026-09-06

The goal, stated plainly: point Fleet at a repository and have it write the
manifest, deploy it, notice what is wrong, fix it, and deploy again — running on
a model on your own machine, with nothing leaving it.

This is an honest account of how much of that exists today.

---

## 1. Where we are

| Stage | State | Evidence |
| --- | --- | --- |
| Read a repository, write a manifest | **done** | `fleet init`, `fleet import` — six services out of the voting app |
| Have a model review that draft | **done, and blind** | it reads only source; see §2 |
| Put a health check in the manifest | **half** | `detect.ts` claims `/` only where structurally certain, `null` otherwise |
| Find the health path a service really answers on | **done, and stranded** | the agent sweeps it; nothing writes it back — see §2 |
| Deploy | **done** | build, schedule, roll out, promote |
| Notice something is wrong | **done** | `fleet diagnose` / `fleet explain`, nine read-only lookups, every finding cited |
| Decide one fix | **done, and narrow** | `fleet fix`, seven editable fields — see §2 |
| Apply, redeploy, verify, roll back | **done** | follows to a conclusion; reverts if a running service does not come back |
| Run entirely on a local model | **done** | LM Studio + Gemma, tunnelled, auth-gated, no token limits |

**The skeleton is complete.** A fault can be found, explained with evidence, fixed
and redeployed without a hosted API. What is missing is not a stage — it is that
the model's knowledge stops at the wrong boundary in three places.

---

## 2. The three gaps, in order of what they would repay

### A. Nothing writes back what was measured

The agent sweeps candidate paths after a deploy and records what answered. That
result reaches exactly one place: a line in `fleet doctor` telling a person to
edit their manifest by hand.

So Fleet establishes the fact and then asks the human to transcribe it. Every
piece of this already exists — the sweep, the storage, the reporting, and
`applyEdits` with its guardrails. Nothing joins them.

This is the smallest change on the list and the only one where the answer is
already known to be correct, because it was measured rather than inferred.

### B. The loop cannot read source

The largest. A service failed because `vote/app.py:21` hardcodes
`Redis(host="redis")` while the manifest names that database `cache`. The
diagnosis traced it correctly — unhealthy, then a Redis connection failure in
the logs — and stopped at *"check the cache service"*, because nothing it can
call reads a repository.

Two blind spots of exactly this shape have already been closed, and both were
worth it:

- `history`, because "somebody stopped it" was invisible in every other view
- `context`, because a build failure's cause lived only inside the uploaded
  archive

This is the third. A service's source is a handful of files — the entry point,
the dependency manifest, the Dockerfile — and `cli/src/repomap.ts` already knows
how to choose them and bound them to 14kB.

### C. `fleet fix` is narrower than the faults are

Seven editable fields: `container_port`, `health`, `resources`, `placement`,
`replicas`, `env`, `command`.

Both real failures this week fell outside them. One needed a database renamed
(`name` is forbidden — a rename points a service at a new volume, harmless for a
cache and data loss for a database). The other needed a source file changed,
which is not a manifest edit at all.

**This is a designed limit, not a defect**, and §5 is about what widening it
would actually cost.

---

## 3. The plan

### Step 1 — write back what was discovered

`fleet doctor --fix` (or a prompt inside `fleet tune`) offers to write the
discovered health path into `fleet.yaml`, using the same edit machinery
`fleet fix` uses, with the same confirmation and the same forbidden list.

Small, and it turns a measured fact into a manifest without a human retyping it.

**Cost:** one CLI path. No new AI surface, no schema change, no model call.

### Step 2 — a `source` lookup

A read-only lookup returning the few files a service is built from, chosen by
the existing `repomap` tiering and bounded the same way.

Three things it must get right:

- **Scoped to the service's build context.** `vote` may see `./vote`, not the
  repository.
- **Bounded hard.** A lookup that returns 40kB blows the token budget that
  `KEEP_IN_FULL` and the deadline were carefully built to protect.
- **It is evidence, not instruction.** Source read this way is untrusted input.
  A comment in somebody's repository saying "ignore previous instructions" must
  be data, exactly like a log line or a comment on an artifact.

With it, the vote failure resolves in one more lookup: the logs say Redis is
unreachable, the source says the host is `redis`, the services list says no such
service exists — and the fix names itself.

**Cost:** one lookup, one prompt line, and care about the boundary.

### Step 3 — let a fix span two files, still with a person at the gate

Once source is visible, the class of fix widens on its own: "your app expects
hostname `redis`; your manifest calls it `cache`" has two possible remedies, and
the loop can now see both. It should propose the safe one (rename in the
manifest) and say plainly that the other (edit the source) is outside what it
will do.

**Cost:** nothing new structurally. The guardrails already exist.

---

## 4. What this does not get you, and why

After all three steps Fleet will:

- write a manifest from a repository
- deploy it
- discover the health path and offer to record it
- find a fault, with evidence, citing what it looked at
- propose one exact change and, with a yes, apply, deploy, verify and revert it

It will still **ask before changing anything**, and it will still refuse the
class of edits that can destroy data.

That is not a missing feature. Everything this project has learned in a week
says the same thing: a model reads a repository well and reasons badly about
the machines it will run on. It invented a node from a compose service name. It
replaced a `build:` with `image: nginx:alpine` and served nginx's welcome page
over a live site. Both were confident and plausible; both were caught by a
guardrail rather than by better prompting.

The loop is safe to point at a live fleet **because its tools cannot act**, and
`fleet fix` is defensible **because a person approves and every step is
reversible**. Removing the approval does not make it more autonomous, it makes
it unaccountable — the same system with nothing standing between a wrong
inference and a running deployment.

If unattended operation is wanted, `--yes` already exists and is the honest way
to ask for it: an explicit choice, per run, that waives the question and not the
refusals.

---

## 5. If we did want to widen what a fix may touch

Not recommended yet, and worth writing down so the decision is deliberate rather
than gradual.

A rename could be made safe by *class*: renaming a Redis service is recoverable
because the volume holds a cache, renaming a Postgres service is not. Fleet
knows the engine. So the rule could be "renames allowed where the engine has no
durable data", which is a property of the system rather than a judgement by the
model.

That is a real design, and it should wait until steps 1–3 have run against
several real repositories. Every widening so far has been paid for by an
incident.

---

## 6. Order, and why

1. **Write-back.** Smallest, and the fact is already measured rather than
   inferred — the only item here with no chance of being wrong.
2. **`source` lookup.** Largest return; closes the third and last blind spot of
   a shape already closed twice.
3. **Two-file fixes.** Falls out of step 2 almost free.

Step 2 is the one worth doing carefully. It is also the one where an untrusted
input reaches a model that can propose changes to a running system, so the
boundary matters more than the feature does.
