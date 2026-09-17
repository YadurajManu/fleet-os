# Hyperframes Composition Brief: Fleet OS

## Objective
Create a stunning, high-aesthetic developer launch trailer (Instagram Reel / Shorts / TikTok format, 9:16 vertical) for Fleet OS.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: portrait — 1080x1920 (9:16)
- Duration: 19.0 seconds

## Source Material
- Project root: `/Users/sujeetkumarsingh/Desktop/Fleet`
- Primary files referenced: `www/src/components/Hero.jsx`, `www/src/components/Problem.jsx`, `www/src/components/Failover.jsx`, `www/src/lib/data.js`
- Product name: Fleet OS
- Tagline / strongest claim: "Deploy to hardware you already own. Without a cloud bill."
- Key UI moments to recreate:
  - One-line installer terminal: `curl -fsSL https://fleetos.sh/install | sh`
  - Multi-node encrypted mesh topology (Home Server `amd64`, Pi 5 `arm64`, ThinkPad `amd64`)
  - Automated multi-arch Buildx pipeline (`linux/arm64 ✓  linux/amd64 ✓`)
  - The 4.1-second live failover reschedule when a laptop lid closes or power is pulled
  - Outro punchline: "Your cluster in a drawer. Open source & self-hosted."

## Creative Direction
- Tone preset: `cinematic` with high-precision developer aesthetic
- Creative direction: *High-stakes developer infrastructure trailer — bare-metal rebellion against cloud bills.*
- Pacing: Fast, energetic entrances (0.3s) with generous settled reading holds (1.2s–1.8s) for every piece of text.
- Pacing & Cuts: 5 scenes across 19.0s synced to 120 BPM driving tempo.

## Visual Identity
- Background: Deep obsidian `#08090b` with technical coordinate grid
- Accent / Signal: Glowing terminal green `#3fe08b`
- Border / Line: `#1b212a` and `#272f3a`
- Status / Warn: `#ffb86c` (warning), `#ff5555` (node down)
- Text: Primary `#e8ebef`, Muted `#939ba7`, Dim `#525c6a`
- Display font: `Archivo`
- Monospace font: `JetBrains Mono`

## Audio
- Audio role: Driving electronic rhythm with mechanical keyboard and telemetry accents
- Music: `assets/music/happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`
- Tempo: 120.19 BPM
- Volume: 0.85, smooth fade-out at 18.0s–19.0s
- Key beat locks:
  - 3.2s: Scene 1 to Scene 2 transition (terminal pair)
  - 7.2s: Scene 2 to Scene 3 transition (multi-arch buildx)
  - 11.2s: Scene 3 to Scene 4 transition (heartbeat failover drama)
  - 15.6s: Scene 4 to Scene 5 transition (outro logo slam)
