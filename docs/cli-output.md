# CLI output

Fleet's human output uses the same small visual vocabulary across commands:

| Style | Meaning |
| --- | --- |
| Green `●` | Healthy, running, or online |
| Yellow `▲` | Warning or degraded |
| Red `✖` | Failure or offline |
| Dim `○` | Idle or not deployed |
| `◌` | Pending or in progress |
| Dim grey | Secondary measurements and metadata |
| Cyan | Commands and URLs the operator can act on |
| Bold | Section headings |

Glyphs always appear with a text label where status matters. Tables align on
visible terminal width, truncate long cells, and hide lower-priority columns on
narrow terminals. `fleet status --verbose` adds sample age, agent and engine
versions, CPU, tunnel and disk state, build reserve, and the latest runtime
errors. Normal status output keeps stale or unavailable measurements as `—`.

## Color and terminal support

- Color and terminal links are disabled when stdout is not a TTY.
- Set `NO_COLOR` to disable color, or pass `--no-color`. Both take precedence
  over `--color always`.
- `--color auto|always|never` is still available for interactive terminals.
- If the locale is not UTF-8, status glyphs use ASCII equivalents. `--ascii`
  and `FLEET_ASCII=1` force that mode; `FLEET_UNICODE=1` opts in explicitly.
- `fleet status --watch` refreshes every two seconds and requires a terminal.
  `--all` shows up to 200 recent events; the default remains five.
- `--json` remains a separate machine-readable output path. Presentation
  changes must not add fields, reorder data, or alter its serialized bytes.

## Error translations

Known low-level messages are translated in `cli/src/error-translation.ts`; unknown
messages stay visible as received. To add a translation, add a narrow regular
expression and a short, factual sentence to `translations`. Include a test for
the raw form and keep the fallback test so unfamiliar errors are not hidden.

## Output boundaries

Deployment progress already uses the shared stage ladder, with in-place updates
on a TTY and transcript lines when redirected. `fleet logs` and `fleet run`
preserve the target application's output so they remain useful with pipes and
scripts; Fleet does not decorate those payload bytes.
