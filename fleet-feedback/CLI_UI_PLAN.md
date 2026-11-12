# CLI output redesign plan

## Scope

Presentation-only changes in `cli/`. Preserve command data requests, behavior,
exit codes, flags, and byte-for-byte `--json` output. Do not edit the control
plane, agent, or server.

## Files and approach

- `cli/src/render.ts` and a small `cli/src/ui/` module: shared theme, status
  glyphs, width-aware tables, load bars, relative times, hints, and problem
  blocks. Respect TTY, `NO_COLOR`, `--no-color`, and UTF-8 capability.
- `cli/src/commands/status.ts`: put fleet health and positive counts first;
  combine node details into one table; group matching failures; give each
  problem an applicable command; keep recent events concise; add TTY-only
  `--watch`, `--all`, and `--verbose` presentation options.
- `cli/src/commands/nodes.ts`, `services.ts`, `backups.ts`, `run.ts`,
  `updates.ts`, and `progress.ts`: adopt the shared visual language for the
  requested command output and errors without changing API calls or results.
- `cli/tests/`: add renderer unit tests and status snapshots for the requested
  health, terminal-width, color, glyph, and JSON-preservation cases.
- `docs/cli-output.md`: document the theme, terminal fallbacks, verbosity, and
  adding error translations.
- `fleet-feedback/CLI_UI_PLAN.md`: update this plan with shipped and deferred
  items.

## Shipped

- Reused `cli/src/render.ts` and `cli/src/ui.ts`; added shared health glyphs,
  badges, compact load and memory displays, priority-aware tables, clickable
  TTY URLs, and known-error translations. No dependency was added.
- Reworked `fleet status`: overall health and positive counts first, combined
  node table, `--verbose` telemetry, grouped failures and per-problem actions,
  concise recent events, `--all`, and a two-second TTY-only `--watch` view.
- Aligned `nodes ls`, `services`, `events`, backups, and updates with the shared
  table and status styles. Deploy already used the stage ladder and was kept.
- Kept JSON serializers and fetched data unchanged for existing invocations;
  added a status JSON byte-shape test. No API, control-plane, agent, or server
  files changed.
- Added terminal renderer and status regression tests plus output snapshots in
  `cli/tests/snapshots/`; documented output and terminal behavior in
  `docs/cli-output.md`.

## Deferred

- Styling `fleet logs` and `fleet run` payloads: these are application output
  and must remain byte-preserving for pipes and scripts.
- A pinned-node marker in `nodes ls`: the existing node response does not
  identify service pinning, and this presentation-only task must not add API
  requests.
- Runtime dependencies, server changes, additional telemetry fetches, and any
  command semantic or exit-code changes.
