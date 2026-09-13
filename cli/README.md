# Fleet OS CLI (`fleet`)

The command-line interface for **Fleet OS** — git-push deploys onto hardware you already own.

## Installation

### Via npm (Global)
```bash
npm install -g @yadurajfleetos/cli
```

### Run Directly via npx
```bash
npx @yadurajfleetos/cli --help
```

### Build and Install from Source
```bash
git clone https://github.com/YadurajManu/fleet-os.git fleet-os
cd fleet-os/cli
npm install
npm run build
npm link
```

---

## Quick Start

### 1. Sign In
```bash
# Hosted control plane (default: https://fleetapi.plastikworld.xyz)
fleet auth login

# Self-hosted control plane
fleet auth login --api https://fleetapi.example.com

# Sign out (clears httpOnly session cookies)
fleet auth logout
```

### 2. Pair a Machine
```bash
fleet nodes pair
```
Run the generated `curl -fsSL ... | sh` command on the machine you want to add to your fleet.

### 3. Check Fleet Status & Health
```bash
fleet status
fleet doctor
```

### 4. Deploy a Service
```bash
# Validate manifest
fleet validate

# Apply services to fleet
fleet apply

# Plan and deploy a service
fleet deploy web

# Roll back to previous healthy deployment
fleet rollback web
```

### 5. Follow Live Logs
```bash
# Stream logs in real-time via SSE
fleet logs web --follow
```

---

## Command Reference

| Command | Description |
| :--- | :--- |
| `fleet auth login` | Sign in and save secure local session |
| `fleet auth logout` | Sign out and clear httpOnly session cookies |
| `fleet config show` | Show active control plane and selected fleet |
| `fleet use <fleet>` | Choose default fleet |
| `fleet nodes pair` | Generate single-use pairing token for a new node |
| `fleet nodes` | List nodes, status, and resource usage |
| `fleet status` | One-screen overview of fleet health |
| `fleet doctor` | Diagnostic health check across cluster |
| `fleet diagnose <q>` | AI-powered root-cause analysis |
| `fleet apply [file]` | Apply `fleet.yaml` manifest |
| `fleet deploy <svc>` | Plan, build, schedule, and roll out a service |
| `fleet logs <svc> --follow` | Live SSE stream of container logs |
| `fleet logs <svc>` | Read the current log tail |
| `fleet restart <svc>` | Restart a service |
| `fleet rollback <svc>` | Roll back to previous deployment |
| `fleet reschedule <svc>` | Force scheduler to migrate service |
| `fleet where <svc>` | Explain scheduler placement and candidate scores |
| `fleet tune` | Compare allocated RAM vs actual memory consumed |
| `fleet events` | Unified cluster event timeline |
| `fleet backup <svc>` | Create on-demand persistent volume snapshot |
| `fleet backups <svc>` | List volume backups |
| `fleet restore <svc> [id]` | Restore volume snapshot |
| `fleet secrets` | List configured secret keys |
| `fleet secrets set <KEY>` | Securely store a credential |
| `fleet import [file]` | Convert a docker-compose.yml into fleet.yaml |
| `fleet init [--ai]` | Scan repository and scaffold fleet.yaml |
| `fleet validate [file]` | Lint and validate fleet.yaml placement rules |
| `fleet open <svc>` | Open public service endpoint in browser |

---

## License

MIT License.
