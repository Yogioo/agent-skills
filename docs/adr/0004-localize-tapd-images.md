# Localize TAPD images instead of linking them

Status: accepted

Images embedded in a TAPD description or comment are downloaded into `<system temp>/afk-tapd/<story id>/`, and the task body references the absolute local path. `tapd-cli` cannot download them itself — `attachment get-image` and `attachment download` both return a URL only, and `document download` serves project documents — so the adapter asks `tapd-cli` for the signed URL and fetches the bytes with Node's built-in `fetch`.

## Considered Options

- **Write the signed URL into the body.** Rejected: it expires in 300 seconds. A run that reads the requirement late, or a re-run, finds a dead link and cannot tell why.
- **Rewrite the relative path to `https://www.tapd.cn/tfl/...`.** Rejected: that URL answers `200` with `Content-Type: text/html` and a two-byte body, so the executor "successfully" reads a one-byte non-image and reasons from nothing.
- **Attach the image without downloading it.** Rejected: the executor would have to hold TAPD credentials, which it does not.

## Consequences

- `getDetail` writes files and is therefore async. It stays idempotent: a re-run reuses files that are already on disk and skips the `get-image` call.
- Images must not land in the work directory. `afk-run` requires a clean worktree, and its failure rollback runs `git clean -fd`, which would delete them.
- A failed download degrades to `[图片下载失败: <path>]` in the body. One unreachable image must not block the story.
- The rendered path uses forward slashes even on Windows. Backslash is an escape character in markdown, and the dashboard renders the task body as markdown, so `![图片](C:\Users\...)` would show a broken image.
- Nothing cleans the image directory; treat `<temp>/afk-tapd/<story id>/` as a cache.
