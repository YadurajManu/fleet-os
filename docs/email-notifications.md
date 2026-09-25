# Email notifications

Fleet OS separates account security messages from fleet operations. Password
reset, password-change, and unfamiliar sign-in notices are always sent when
email delivery is configured. In Settings, each user can opt in to an email
after every successful sign-in and after browser sign-out. The latter is sent
only when the sign-out request carries a valid refresh cookie; clearing an
expired or unauthenticated browser session cannot identify an account safely.
Signing out consumes that refresh token so the browser cannot renew the
session afterward.

Email alert rules live under Alerts and are scoped to a fleet. A node that
briefly recovers and drops again can generate several `node.down` events, but
an email rule sends at most one node-down message for that node within its
configured cooldown. The default for existing and new email rules is six
hours. Operators can set 12 hours or a custom value from zero to seven days.
Zero disables suppression. The cooldown is stored in the rule's existing
configuration; no migration is needed for alert rules. Redis holds the
per-rule, per-node cooldown across control-plane restarts. A failed delivery
releases its cooldown so the next event can retry. A test alert bypasses it.
When the node recovers, an email recovery notice is sent only if the rule
actually sent a down notice. Recovery does not reset the cooldown, preventing
repeated down/up messages during a flap. Other alert channels are unchanged.

`service.down` is emitted when a running deployment's container is absent
from a nonempty agent container report. It is distinct from `node.down` and
from `service.crash_looping`. No service-down event is inferred from an empty
report, because that may mean Docker telemetry is unavailable rather than
that every container disappeared.

The account preferences require additive migration
`0027_email_preferences.sql`. Production must run migrations before deploying
the new control plane. Older control planes ignore the new columns. This work
does not add email delivery webhooks; a successful Resend API response still
means accepted for sending, not confirmed delivery.

## Follow-ups

- Track Resend message IDs and signed delivery/bounce webhooks, then show
  accepted, delivered, bounced, or failed status in the dashboard.
- Add a quiet-period or daily summary for low-severity operational events.
- Add an incident timeline with first failure, latest transition, count of
  suppressed repeats, and acknowledged/resolved status.
- Verify the trusted-proxy boundary before adding finer IP-derived location
  to account emails; country is approximate and may be unavailable.
- Add a trusted session-revocation flow for CLI logout. Current `fleet auth
  logout` only clears the local CLI profile and cannot support a server-side
  logout notice.
