# The human-facing surface is one page, and it spans execution environments

Status: accepted

This deployment has no inbound notification channel (no permission to send chat-webhook messages), and every other route to the developer is platform-specific. The developer's second step is to accept a result (CONTEXT.md: Two steps), which needs somewhere to sit and be looked at. That place is one HTTP page: it lists the inbox, the requirements, and the items that need a human. It is where the developer finds out that a requirement is waiting.

The page is read-only. It reads registries, work-item pools, inbox items, and requirement records — never `config.json`, so no task-source credential can reach a browser or a log.

This supersedes the "不做跨 Execution environment（workdir）聚合" non-goal in `docs/afk-watch-dashboard-plan.md`. The watcher's page is spawned per workdir and dies with its watcher (ADR-0005); a page that answers "what needs me" has to outlive individual watchers and cover every execution environment.

## Considered Options

- **A desktop notification per event.** Rejected: no dependency-free, reliable option exists across the platforms in use, and a transient toast is not a queue the developer can come back to.
- **An outbound chat webhook.** Rejected for this deployment: no permission to send.
- **Extending the watcher's page only.** Rejected: that page exists only while its watcher does, and it sees one workdir.
- **Letting the page write.** Deferred, not rejected: ADR-0005's page is read-only, and a surface that mutates state needs its own decision. Actions stay in a session for now.

## Consequences

- The aggregate page needs a lifetime of its own, independent of any watcher or execution run.
- Notification is a bookmark, not a push: nothing interrupts the developer. The wake ring covers the agent half (ADR-0008), and the accept step is what brings the developer back.
- Superseding the non-goal leaves ADR-0005 intact: per-workdir pages keep their ownership and the aggregate is an additional surface, not a replacement.
- The page adds a second reader of the same files the wake ring reads, so those files are the contract between them and neither may own state the other needs.
