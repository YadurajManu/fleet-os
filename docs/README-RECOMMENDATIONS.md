# README and open-source adoption recommendations

Review date: 2026-09-20. Scope: GitHub README, project positioning, architecture accuracy, and the path from discovering Fleet to deploying a first app. Recommendations are proposed work, not promises of growth or features already shipped.

## Positioning

Lead with **“Deploy to the hardware you already own.”** Follow with the concrete audience and behavior: developers running Linux containers across Macs, Linux machines and VPSs, including nodes behind NAT. “Heterogeneous edge PaaS” is useful terminology deeper in the docs, but requires too much explanation in the first sentence.

The strongest story to demonstrate is: **a small public control plane coordinates a build on an Apple Silicon Mac at home, then serves the app over HTTPS through its outbound tunnel.** That is specific, visible and grounded in work already exercised. Avoid suggesting Fleet eliminates infrastructure cost, home-network limitations or operational responsibility.

[Supabase's README](https://github.com/supabase/supabase#readme) provides a useful structural reference: a clear product identity, a compact capability list linked to documentation, an explanation of the components, and distinct contribution/support routes. Borrow that clarity rather than its claims, scale, or product category. Fleet's strongest distinction is user-owned compute and outbound connectivity.

## Changes made in this review

| Previous problem | Updated approach |
| --- | --- |
| Dense product category and several competing calls to action | Plain-language promise, audience, one Get started entry point |
| Unverified competitor checkmarks and cost/latency/setup claims | Describe Fleet's actual behavior and operational prerequisites |
| “Operational” badge without monitored status evidence | Real repository CI badge and package/license links |
| Unsupported cross-platform “Verified Active” claims | Separate build targets, implementation and runtime verification |
| Central builds and future NAT mesh in architecture | Agent BuildKit execution, durable jobs, WSS ingress, scoped gateway, local fallback |
| Invalid database placement in one manifest; conflicting quickstarts | Small prebuilt-image example before source-build setup |
| CLI catalog and decorative sections overwhelm first deployment | Link detailed references; keep README focused on discovery and activation |
| Main features presented as already released | Explicit main-versus-published-package distinction |
| No clear boundaries | Single-control-plane, local-volume, emulation and monitored-disk limitations |

The existing dashboard image remains as a product view. It is not proof of current multi-node deployment or the latest UI state; replace it with a reviewed capture before a launch campaign.

## Priorities

| Priority | Recommendation | Concrete deliverable | Success signal |
| --- | --- | --- | --- |
| P0 | Make the quickstart reproducible | Run the documented path on a clean machine, record prerequisites and failure recovery; publish a release only after its gate passes | A new user gets a reachable first app without maintainer intervention |
| P0 | Show the distinguishing behavior | A 60–90 second recording: pair node, opt in builder, deploy, watch logs, open URL; hide credentials and personal data | Viewers can explain where the build and app actually run |
| P0 | Align website, package and repository | Same headline, real GitHub URLs, truthful support matrix and release status; verify every support/contact link | No contradictory promise between README and site |
| P1 | Publish three runnable examples | Small web app; API + pinned Postgres with backup guidance; Mac builder + Linux runtime when verified | Each example has tested commands, prerequisites, expected result and cleanup |
| P1 | Publish the first technical case study | MediLifecycle build/deploy narrative, architecture, fixes and measured conditions; distinguish samples from peak measurements | Readers can reproduce the result; no “zero cost” or universal speed claim |
| P1 | Make tradeoffs easy to evaluate | A documented comparison of intended use, operations and networking, with dated primary sources and limitations for every product | A developer can decide whether Fleet fits without unsupported checkmarks |
| P1 | Give contributors a small first win | Curate 3–5 real issues with reproduction, expected outcome, relevant files and maintainer scope | First-time contributions reach review with fewer clarification rounds |
| P1 | Offer a safe product preview | An explicitly labeled read-only demo with synthetic data or a walkthrough video, rather than a personal production dashboard | Visitors understand the product without creating an account or exposing a real fleet |
| P2 | Build a hardware evidence library | Versioned OS/engine/agent reports for Linux amd64/arm64, Raspberry Pi and Windows; mark failures too | Support labels trace back to reproducible evidence |
| P2 | Clarify roadmap and support | Public milestones for release gates and known limitations; one verified place for questions | Fewer repeated “does this work?” questions and clearer contribution choices |

## Launch and distribution

1. Finish the proof assets before announcing a broad release. Use one working example, a short video, clear prerequisites and a known-limitations section.
2. Publish a technical article around the actual problem: deploying from home behind NAT, or moving container builds off a small VPS onto a Mac. Explain architecture and failure recovery; avoid generic “Kubernetes killer” positioning.
3. Share the relevant article in communities that allow project showcases, following their current rules. Ask for specific hardware or onboarding feedback. Do not mass-post identical promotional copy.
4. Turn recurring setup problems into documentation and scoped issues, then publish a small changelog showing what user feedback changed.

Proposed repository description: **“Deploy Linux containers across hardware you own. Outbound tunnels, platform-aware placement, and opt-in agent builds.”**

Suggested repository topics to review before setting: `self-hosted`, `homelab`, `docker`, `paas`, `arm64`, `deployment`, `golang`, `typescript`. No repository metadata, social posts, community messages, or analytics were changed during this review.

## Measure adoption, not only stars

Start with voluntary onboarding feedback and aggregate repository analytics. Track documentation entry → quickstart start → node paired → first healthy deployment, recording where users stop and time to recovery. Treat this as a proposed measurement plan; no tracking is enabled by this document. If product analytics are added, document collection and consent choices first.

Use stars as a secondary visibility signal. More useful signals are successful first deployments, repeated deployments, issues resolved, and outside contributors returning. Set targets after measuring a baseline rather than inventing conversion or growth forecasts.

## Suggested next two iterations

**Iteration 1: trust and activation.** Validate the new quickstart on a fresh setup, resolve release blockers, capture one accurate dashboard screenshot and the short deployment demo, and check website/contact consistency.

**Iteration 2: useful proof and contribution.** Publish the three example paths, a measured case study, and a small set of contribution-ready issues. Review observed onboarding friction before expanding marketing channels.

Keep the README short enough to scan. Move benchmarks, full command lists, release history and operational runbooks into linked documents. Make every performance claim reproducible and every verification claim traceable.
