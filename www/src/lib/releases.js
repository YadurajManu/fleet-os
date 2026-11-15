// Verified against npm, the hosted /healthz endpoint and the served agent binaries.
// Dates describe publication or hosted deployment, never a merge timestamp.
export const RELEASES_CHECKED_AT = '2026-11-15'
const repository = 'https://github.com/YadurajManu/fleet-os'
export const RELEASE_COMPONENTS = [
  {
    id: 'cli', name: 'CLI', version: '0.27.1', channel: 'Published on npm', publishedAt: '2026-11-13T03:05:38.869Z',
    sourceLabel: 'npm package', sourceUrl: 'https://www.npmjs.com/package/@yadurajfleetos/cli/v/0.27.1',
    summary: 'Clearer status summaries, responsive tables and actionable terminal output.',
    command: 'npm install -g @yadurajfleetos/cli@latest\nfleet --version\nfleet updates',
    note: 'Run on your computer. Updates the CLI only; your server and agents keep their current versions.',
  },
  {
    id: 'server', name: 'Control plane', version: '0.2.0', channel: 'Hosted deployment', publishedAt: '2026-11-14',
    sourceLabel: 'Deployed source', sourceUrl: `${repository}/commit/99ad328d5301d53fd32b852d634c52271122e39b`, revision: '99ad328d5301',
    summary: 'Public status, recorded uptime, incident history and private fleet health.',
    command: 'sudo ./deploy/upgrade.sh check\nsudo ./deploy/upgrade.sh apply',
    note: 'Self-hosted Compose installs: run from a clean main checkout on the server. The updater verifies a database backup before applying migrations. Hosted users do not run this command.',
  },
  {
    id: 'agent', name: 'Agent', version: '0.4.0', channel: 'Hosted binary', publishedAt: null,
    sourceLabel: 'Download checksums', sourceUrl: 'https://fleetapi.plastikworld.xyz/install/SHA256SUMS',
    summary: 'Build targets, fractional CPU limits and one-off tasks on your machines.',
    command: 'fleet updates',
    note: 'Check the binaries served by your control plane, then enable one node in Dashboard → Settings → Updates. Confirm its version and fresh heartbeat before enabling others. Auto-upgrade is off by default. The hosted binary is newer than the GitHub preview; its publication date is not recorded.',
  },
]

export const RELEASES = [
  {
    id: 'server-99ad328', component: 'server', version: '0.2.0', channel: 'Hosted deployment', publishedAt: '2026-11-14',
    title: 'A clearer picture of platform health', summary: 'The public status system now measures, remembers and explains the health of Fleet infrastructure.',
    changes: ['Public component health, recorded uptime and incident history, with neutral unknown and stale states.', 'A separate prober, hourly and daily rollups, maintenance windows and dependency-linked incidents.', 'Authenticated fleet-health views; public responses exclude customer identities and workloads.'],
    upgradeNote: 'Self-hosted: additive migrations 0039–0041 and the separate status-prober process are required. The Compose updater starts the prober. Optional synthetic canaries require explicit configuration.',
    sourceLabel: 'Deployed source · 99ad328d5301', sourceUrl: `${repository}/commit/99ad328d5301d53fd32b852d634c52271122e39b`,
  },
  {
    id: 'cli-0-27-1', component: 'cli', version: '0.27.1', channel: 'Published on npm', publishedAt: '2026-11-13T03:05:38.869Z',
    title: 'Less noise. More useful answers.', summary: 'A more readable CLI, from a quick health check to a detailed deployment investigation.',
    changes: ['Clear status summaries and grouped problems.', 'Responsive tables and terminal-aware colors.', 'Actionable errors that make the next step easier to find.'],
    upgradeNote: 'Update the npm package on each operator machine. Existing server and agent installations are not updated by npm.',
    sourceLabel: 'npm · v0.27.1', sourceUrl: 'https://www.npmjs.com/package/@yadurajfleetos/cli/v/0.27.1',
  },
  {
    id: 'cli-0-27-0', component: 'cli', version: '0.27.0', channel: 'Published on npm', publishedAt: '2026-11-12T05:24:02.758Z',
    title: 'More control over builds and machines', summary: 'Better build configuration, deployment recovery and day-to-day fleet operations.',
    changes: ['Custom Dockerfiles, named build stages, build arguments and smaller source uploads.', 'One-off service tasks and reattachment to an exact deployment attempt.', 'Node rename and authorized replacement, hidden-value secret copying and clearer build-secret setup.'],
    upgradeNote: 'Advanced protocols require the matching control-plane 0.2.0 update, migrations 0033/0034 and agent 0.4.0. Check the server revision as well as its version.',
    sourceLabel: 'npm · v0.27.0', sourceUrl: 'https://www.npmjs.com/package/@yadurajfleetos/cli/v/0.27.0',
  },
  {
    id: 'cli-0-25-0', component: 'cli', version: '0.25.0', channel: 'Published on npm', publishedAt: '2026-10-03T20:33:41.719Z',
    title: 'Know what is running before you update', summary: 'Separate update paths for your computer, server and nodes.',
    changes: ['fleet updates reports the server revision, CLI version and node agent versions.', 'A per-node upgrade policy enables a canary, pause or inherited fleet policy.', 'Offline node versions are explicitly last reported values.'],
    upgradeNote: 'Server revision reporting requires a matching control-plane update. Checking for updates never starts a rollout.',
    sourceLabel: 'npm · v0.25.0', sourceUrl: 'https://www.npmjs.com/package/@yadurajfleetos/cli/v/0.25.0',
  },
  {
    id: 'agent-0-3-0-preview', component: 'agent', version: '0.3.0', channel: 'GitHub preview', publishedAt: '2026-09-28T21:39:28Z',
    title: 'Build on the hardware you own', summary: 'The first published preview of agent-delegated builds and platform-aware node reporting.',
    changes: ['Platform-specific Linux, macOS and Windows binaries with SHA-256 checksums.', 'Agent-delegated builds and platform capability reporting.', 'Published as a preview; the release notes describe the remaining Windows and end-to-end verification limits.'],
    upgradeNote: 'This is the older GitHub preview, not the current hosted 0.4.0 binary. Agent updates read your control plane’s served binaries and require explicit opt-in.',
    sourceLabel: 'GitHub preview notes', sourceUrl: `${repository}/releases/tag/agent-v0.3.0`,
  },
]
