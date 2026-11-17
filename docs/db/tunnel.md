# Database tunnel protocol

The additive `db.*` messages share the authenticated agent WebSocket. Version 1 is independent of existing HTTP, terminal, task and build messages. A node's response is accepted only from its current socket and for that node's operation/session ID.

`db.exec.open` and `db.tcp.open` carry a UUID session ID, database identity (fleet, project, database, node and generation), role and timeout. TCP reaches only the database container's loopback engine port through Docker exec. No database host port is published. The private helper supports PostgreSQL, PgBouncer and Redis ports only. Exec uses an allowlist of client programs and separate OS users for owner, app and readonly clients.

The opener offers `window: 16`; `db.opened` selects 16 or 1. Missing selection uses 1 for compatibility. Each direction has independent sequence numbers beginning at 1. A `db.data` payload is canonical base64 of at most 32 KiB. A sender may have at most the selected number of unacknowledged frames. Each strictly ordered `db.ack` returns one credit after the receiver consumes that frame. Acknowledgements never grant more than the initial window. Duplicate, skipped and oversized frames cancel the session.

The control plane stops granting credits once its readable buffer reaches 64 KiB. It returns held credits as the reader drains. At most 16 additional frames can arrive while credits are held. The agent maintains a bounded input channel and counts unconsumed frames; its output blocks when the window is exhausted. Both sides serialize output frame sequences. EOF follows acknowledgement of preceding input, and final session closure follows acknowledgement of preceding output.

`db.eof` half-closes input so binary responses can finish. `db.close`, expiry, revocation or tunnel loss cancels the session. A protected per-user Unix socket in the container lets the agent terminate that client's process group without stopping the database. Reconnect creates a fresh session; SQL and interrupted writes are never replayed automatically.

`db.operation` carries an operation ID and plan. The runtime stores a credential-free receipt with its identity, generation, input fingerprint, phase and completion state. Reusing an operation ID with different input is rejected. Restart checkpoints record the clean stop before starting, so reconciliation does not repeat the stop. Higher generations require explicit fenced recovery; a missing data volume is not silently replaced.

Verification commands and measured local results are in PROGRESS.md. The Docker fixture runs two real Go agent instances with distinct node IDs on one local Docker host, a private Redis container and a service task belonging to the other node. Each WebSocket direction has 50 ms simulated delay. This proves logical node and tunnel behavior; it does not establish separate-hardware or Windows runtime coverage.
