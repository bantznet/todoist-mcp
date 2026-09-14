# Agent guidance

This repo packages the official Todoist MCP server
([`@doist/todoist-mcp`](https://github.com/Doist/todoist-mcp)) as a container
image served over Streamable HTTP.

## Read first

1. [`README.md`](README.md) — behaviour and configuration.
2. [`PUBLISHING.md`](PUBLISHING.md) — build, release and verification.
3. [`docs/MAINTAINER-NOTES.md`](docs/MAINTAINER-NOTES.md) — design decisions,
   verified facts and known limitations.

## Hard constraints

- **Never put secrets in the repo.** No Todoist API key, no registry PAT, no
  `.env`. The API key is a runtime environment variable only.
- **Do not add QEMU or arm64 emulation** to
  [`.github/workflows/publish.yml`](.github/workflows/publish.yml): Node's `npm`
  crashes with SIGILL (exit code 132) under arm64 emulation. arm64 needs a
  native ARM runner.
- **The host-check bypass is intentional.** [`entrypoint.mjs`](entrypoint.mjs)
  fronts the server with a proxy that rewrites `Host`/`Origin`, so upstream's
  DNS-rebinding guard never fires and any client hostname works. Do not "fix"
  this by re-enabling the guard, and keep the trade-off disclosed in
  [`README.md`](README.md).
- **Keep the image and its user-facing docs environment-agnostic.** No
  orchestrator, network or personal-environment assumptions in
  [`Dockerfile`](Dockerfile), [`README.md`](README.md) or
  [`PUBLISHING.md`](PUBLISHING.md).
- **Do not assume read-only.** The image exposes the full upstream tool surface;
  access control is the consuming client's responsibility.
- **Node 24 is upstream's floor.** Do not lower `NODE_VERSION`.

## Verification mindset

A green CI build proves the image builds, not that it works. The entrypoint
binary name and the environment variable names are only proven by running the
container — see the verification log in the design notes.
