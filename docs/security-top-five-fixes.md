# Security audit: first five fixes

## Scope and behavior

1. Service log streams require a user access token (Bearer or dashboard cookie), `logs.read`, and membership in the organization owning the service. Anonymous requests return 401; other organizations receive 404. Runtime channels remain keyed by fleet and service IDs. Redis subscribers connect once, are shared during initialization, and are released on disconnect.
2. Host terminals require the explicit `node.terminal` permission, granted to admins and owners. Viewers and deployers receive 403 before an agent terminal starts. The node detail UI follows the same roles.
3. Access and refresh tokens share a random session ID, backed by a Redis record with a 30-day TTL. Rotation preserves that ID and atomically checks that it is still active. Device revocation invalidates the matching credentials; revoke-others keeps only the caller's actual session, including when another login uses the same browser family. Password reset invalidates access credentials as well as refresh tokens. Logout invalidates its session. Already-open log streams and terminals check revocation and token expiry every five seconds and close on validation failure.
4. TOTP setup refuses an account with an enabled factor. Enable uses an atomic database condition (`totp_secret IS NULL`) so a stale enrollment cannot overwrite a factor enabled by another request. Changing a factor requires the existing confirmed disable flow first.
5. GitHub identity uses an email verified by GitHub's emails API; a public profile email is insufficient. Automatic linking refuses an existing unverified password account. The owner must recover/sign in and verify that account first. Verified account linking and its existing TOTP challenge remain available.

## Rollout implications

- Existing browser and CLI credentials have no session ID and must sign in again once after deployment. No agent credentials, pairing, applications, or database schemas change. CLI users can run `fleet auth login`.
- The existing remembered-device UI still groups browser and OS families; revoking a displayed device invalidates all credentials issued for that family. Revoke-others retains only the exact calling credential session. This is not a new device fingerprinting system.
- Redis is required for user credential validation. A Redis outage fails closed. The production Compose configuration already persists Redis; no new dependency is added.
- HTTP authorization takes effect on the next request; an already-open stream or terminal closes within five seconds. Role changes are checked at terminal connection time; continuously reevaluating organization membership is separate work.

## Validation

Regression coverage: anonymous/cross-organization log stream rejection; authorized cookie seeding and live log delivery; terminal upgrades for all four roles; revocation of current access and rotated refresh tokens; same-browser revoke-others; refusal to recreate a revoked session; revocation of open streams and terminals; protection of an existing TOTP factor; unverified account-link rejection and verified linking; rejection of unverified GitHub profile email.

Run the existing control-plane typecheck/build and test suite against an isolated Postgres/Redis test environment, plus dashboard typecheck, tests, and build. Tests added in `control-plane/tests/security-top-five.test.ts`. No production attack probes or test accounts are needed.

## Production rollback (recorded before deployment)

Previous server revision: `2905e19873b60c652d7c53b780471997c6b8577f`.

Previous image IDs:

- Control plane: `sha256:8103daa9adc8d74442dd13dc9f4407f01f49e6cf20cd55c6f36664e569143f38`
- Dashboard: `sha256:63ef1ab086642f7bc12fc65c0e3a5ca697fd16502414369b385edc61f16942a0`

Backup directory: `/opt/fleet-os/backups/security-top-five-20261005` (rollback script, image override, and revision record; no database changes).

Exact rollback command:

```sh
ssh fleet-cp 'bash /opt/fleet-os/backups/security-top-five-20261005/rollback.sh'
```

The script restores the recorded source revision and recreates only control-plane/dashboard containers from the recorded images with `--no-build --no-deps`. It does not restore revoked credentials or alter agent installations. Rolling back also restores the older security behavior; use only for a deployment failure.
