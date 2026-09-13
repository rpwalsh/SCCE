# Blackboard

Durable shared state for parallel agents. Agents do not talk to each other; they read and write here.

- `tasks/` one file per bounded task. An agent claims a task by setting `claimed_by` in its front matter.
- `findings/` one file per completed task: root cause, files changed, tests run, remaining uncertainty, commit.
- `decisions/` architectural calls that later tasks must respect.

## Shared, serialized resources

SCCE has one PostgreSQL database and one server on port 3873. They are NOT per-worktree.

- Read-only SQL from a worktree is fine and parallel-safe.
- `scripts/restart-server.sh`, live `/api/turn` calls, and anything writing to the database are SERIALIZED.
  A worker must never restart the server. Live verification belongs to the integrator.
- Credentials live only in the untracked `scce.config.local.json`. Never print or commit them.
