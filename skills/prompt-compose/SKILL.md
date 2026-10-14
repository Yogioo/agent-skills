---
name: prompt-compose
description: Compose a prompt from an explicit JSON manifest (base text/file, ordered layers, caller-defined suffix and variables) and emit the composed text plus machine-readable source provenance. Use when assembling layered system prompts outside AFK.
---

# Prompt Compose

Build one prompt deterministically from a JSON manifest. There is no implicit file
discovery, no fixed roles, no AFK home lookup and no baked-in footer.

```powershell
node <skill>/scripts/cli.mjs --manifest <manifest.json> --out <prompt.md> [--provenance <provenance.json>] [--force]
```

Success prints one JSON provenance object on stdout and writes the composed prompt
(and optionally the provenance file) atomically. Exit codes: `0` success, `1` I/O or
missing source file, `2` invalid manifest, unknown variable, or a refused input/output
alias. `--out` refuses to overwrite an existing file unless `--force` is given. The
`--out` and `--provenance` paths must be distinct, and neither may name the input
manifest or any source file, even with `--force`: overwriting an input is always an
error.

## Manifest

```json
{
  "variables": { "TASK": "fix the bug" },
  "base": { "file": "base.md" },
  "layers": [
    { "mode": "replace", "label": "project base", "file": "project-base.md" },
    { "mode": "append", "label": "house standards", "text": "Be concise.\n\n{{TASK}}" }
  ],
  "suffix": { "text": "Always reply as JSON." }
}
```

- `base` — starting text, either `{ "text": ... }`, `{ "file": ... }` or a bare string.
- `layers` — ordered. `mode: "append"` (default) adds a block after the base;
  `mode: "replace"` replaces the effective base and the last replacement wins.
  An optional `heading` renders a `## <heading>` line above the layer.
- `suffix` — caller-supplied final block, appended last. Nothing else is injected.
- `variables` — substituted for `{{NAME}}`. Unknown placeholders are an error, never
  silently blanked. A missing `file` is an error; empty or whitespace-only content
  (from a file or inline) is treated as absent and contributes no section.

Relative `file` paths resolve against the manifest directory (or `baseDir` in the API).
Provenance lists every source in output order with its role, resolved path and whether
it was included, so independent callers can audit composition.

## API

`scripts/prompt-compose.mjs` exports `assemblePrompt(manifest, { baseDir })` returning
`{ text, sources, variables }`, plus `renderTemplate()` and `PromptComposeError`. It is
self-contained and does not import the legacy execution skill.
