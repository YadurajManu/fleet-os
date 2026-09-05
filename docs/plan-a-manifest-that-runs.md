# A manifest that runs first time

**Status:** proposal, for discussion. Nothing here is built.
**Date:** 2026-09-06

The goal: `fleet init --ai` on any repository produces a `fleet.yaml` that
deploys and works — whatever the language, whatever the database, without a
person correcting it first.

Docker's example voting app is the worked example throughout, because it broke
in four different ways in one afternoon and every break is on this list.

---

## 1. What `init` produces today

Run against the voting app, it found five services and got the shape right. It
also produced, without saying so, a manifest that could not work.

| What it wrote | What was true |
| --- | --- |
| a database named `cache` | the application connects to the hostname `redis` |
| `node: CHANGE_ME` on two databases | three more services silently inherited it |
| `ram: 512Mi` on all five | measured steady state was 20MB and 60MB |
| no health check anywhere | two of the services answer 200 on `/` |
| `worker` as "existing Dockerfile" | it is .NET, which `detect.ts` does not know |

None of these are the model being careless. Four of the five are things a
repository cannot answer, and the fifth is a gap in a table.

### What it can detect

`node` (and Next.js), `python`, `go`, `rust` — from `package.json`,
`pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`.

### What Fleet can manage

`postgres`, `mysql`, `mariadb`, `redis`, `mongo`.

---

## 2. The four gaps, in order of what they cost

### A. It names things what the compose file called them, not what the application calls them

The single most instructive failure of the week, and the cheapest to fix.

`fleet init` named the Redis database `cache`, because the compose file called
that service `cache`. The application says:

```python
g.redis = Redis(host="redis", db=0, socket_timeout=5)
```

Fleet's network resolves a database by the name the manifest gives it, so
`vote` looked up `redis`, found nothing, and failed every request. The service
ran, reported unhealthy for ever, and three separate investigations traced it
before one could read the source and say so.

**A database's name is not a label. It is the hostname the application will
use, and the application has already decided what that is.** It is written in
the source, one grep away, and `init` never looks.

This is not an AI feature at all — it is a regex over the entry point for
`Redis(host=…)`, `createClient({ url: …})`, `DATABASE_URL`, `MONGO_URL`. The AI
review is the right place to catch what the regex misses, not the first line of
defence.

### B. Four languages, and the fifth is in the example

`detect.ts` covers node, python, go and rust. The voting app's `worker` is .NET
and fell through to "existing Dockerfile", which happens to work because the
repository has one — and produces nothing at all for a repository that does not.

Missing, roughly in order of how often they appear: **.NET** (`*.csproj`),
**Ruby** (`Gemfile`), **Java** (`pom.xml`, `build.gradle`), **PHP**
(`composer.json`), **Elixir** (`mix.exs`), **Bun** and **Deno**, and static
sites with no runtime at all.

Each is a table entry and a Dockerfile template. This is the least interesting
work on the list and probably the highest total return.

### C. The port

`container_port` wrong is a 502 with every status green, and it is the failure
this project has hit most often. A backend serving on 3100 with the manifest
saying 8080 forwards traffic to a closed port and reports running.

The port is usually in the source — `app.run(port=80)`, `listen(3000)`,
`EXPOSE`, `ASPNETCORE_URLS` — and sometimes only in the Dockerfile. `detect.ts`
reads some of these. It should read all of them, and where two disagree, say so
rather than picking.

### D. What the application expects to be told

Related to A but distinct. An application either hardcodes a hostname or reads
one from the environment, and which it does decides what a correct manifest
looks like:

- reads `REDIS_HOST` → the manifest should set `env: { REDIS_HOST: cache }`
  and the database may be called anything
- hardcodes `redis` → the database must be named `redis`

Both are visible in the same few lines of source. Today neither is looked at,
so the manifest is right by luck.

---

## 3. The plan

### Step 1 — read the entry point for what it connects to

Before any model is asked anything. A short pass over the same files
`cli/src/source.ts` already selects, looking for:

- database clients and the hostname each names
- environment variables read, with their defaults
- the port listened on

Then **name each database what the application calls it**, and set `env` for
what it reads. Where the source hardcodes a name Fleet cannot use, say so in a
comment in the generated manifest rather than silently picking.

**Why first:** it is deterministic, it needs no model, and it fixes the failure
that cost the most.

### Step 2 — the language table

.NET, Ruby, Java, PHP, Elixir, Bun, Deno, static. Each is a detector, a
Dockerfile template, and a default port. Mechanical, and testable one at a time.

**Why second:** it is the difference between "works on the four languages we
tried" and "works".

### Step 3 — let the AI review see what step 1 found

The review reads the repository today and guesses. Given the connection facts
from step 1, it stops guessing about those and can spend itself on what it is
actually good at: noticing that a service has no health check and the repository
has a `/healthz` route, that two services declare the same volume name, that a
worker with no ports does not need a hostname.

### Step 4 — verify against real repositories, by deploying them

The part that makes the rest honest.

A corpus of perhaps a dozen public repositories across the languages in step 2,
and a test that runs `fleet init --ai` and then `fleet apply --dry-run` against
each. The manifest either validates or it does not, and that is a fact rather
than an opinion.

Deploying them for real is better and much slower; it belongs in a nightly run
rather than in the suite.

**Why last:** it measures the other three, and there is no point building a
measurement before there is something to measure.

---

## 4. How we will know it worked

One number: **how many of the corpus deploy without a human editing the
manifest.** Today, for the voting app, that number is zero — it needed a node
name, a database rename, and would still have had no health checks.

Not "does the manifest look right". Manifests that look right are exactly what
this project keeps shipping and then debugging.

---

## 5. What this deliberately does not do

**Guess a health check.** Discovery already finds the real path after one
deploy, and `fleet tune --apply` writes it back. A guess at `init` time competes
with a measurement taken later, and loses — a manifest that guessed `/` on a
backend serving under a route prefix probed 404 for ever.

**Guess memory.** Same argument. `fleet tune` measures it. `512Mi` as a stated
placeholder is honest; a number invented per service would look like knowledge.

The principle both share, and the one worth carrying into every part of this:
**where a fact can be measured later, `init` should say plainly that it does not
know, rather than write a plausible number.** A manifest full of confident
guesses is worse than one with honest gaps, because the gaps get fixed and the
guesses get deployed.
