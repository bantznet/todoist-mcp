# todoist-mcp

**Unofficial container image for the official Todoist MCP server
([`@doist/todoist-mcp`](https://github.com/Doist/todoist-mcp)), served over
Streamable HTTP.**

Upstream ships to npm only — there is no official image. This packages that
release as a small, non-root container any MCP client that speaks Streamable HTTP
can connect to. It is deliberately generic: no orchestrator, network or
tool-policy assumptions, and no host allowlist to maintain. It exposes the full
upstream server (read **and** write tools); deciding what a client should use is
the client's job.

| | |
|---|---|
| **Image** | `ghcr.io/bantznet/todoist-mcp:<upstream-version>` |
| **Upstream** | [`Doist/todoist-mcp`](https://github.com/Doist/todoist-mcp) |
| **Transport** | Streamable HTTP — `/mcp` (probe at `/health`) |
| **Platforms** | `linux/amd64` (arm64 needs a native ARM runner — see [PUBLISHING.md](PUBLISHING.md)) |
| **Base** | `node:24-alpine`, runs as non-root `node` |

**Jump to:** [Quick start](#quick-start) · [Configuration](#configuration) ·
[Host checking](#host-checking) · [Endpoints](#endpoints) ·
[Access control](#access-control) · [Connecting a client](#connecting-a-client) ·
[Security](#security-notes) · [Troubleshooting](#troubleshooting)

---

## Quick start

Create an API key in Todoist under **Settings → Integrations → Developer** and
treat it like a password.

**Docker Compose**

[`docker-compose.yml`](docker-compose.yml) runs the published image, so there is
nothing to build:

```bash
cp .env.example .env          # paste your API key into .env
docker compose up -d
docker compose logs -f todoist-mcp
```

`docker compose up` pulls from GHCR. If the package is private, log in on the
host first:

```bash
echo <PAT-with-read:packages> | docker login ghcr.io -u bantznet --password-stdin
```

The compose file tracks `:latest`, so a pull always gets the newest release. Pin a
version tag (`ghcr.io/bantznet/todoist-mcp:13.2.5`) instead if you need to know
exactly what you are running, or to roll back.

**docker run**

```bash
docker run -d --name todoist-mcp \
  -e TODOIST_API_KEY=<your-api-key> \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/bantznet/todoist-mcp:<upstream-version>
```

Any hostname works — there is no allowlist to configure (see
[Host checking](#host-checking)). To build the image yourself, see
[PUBLISHING.md](PUBLISHING.md).

Confirm it is up:

```bash
curl -s localhost:3000/health    # expect HTTP 200
```

---

## Configuration

All configuration is runtime environment variables; nothing sensitive is baked
into the image.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TODOIST_API_KEY` | **Yes** | — | Authenticates to Todoist. The name is `_KEY`, not `_TOKEN`; the server exits if it is unset. |
| `HOST` | No | `0.0.0.0` | Public bind address. |
| `PORT` | No | `3000` | Public listen port. The server itself runs on `PORT+1`, inside the container. |
| `TODOIST_BASE_URL` | No | upstream default | Overrides the Todoist API base URL. Rarely needed. |

Upstream also reads `TZ`, `USE_STRUCTURED_CONTENT` and `MCP_TOKEN_BUDGET`; they
pass through untouched. Upstream's `ALLOWED_HOSTS` is **not used by this image** —
see below.

The shipped [`docker-compose.yml`](docker-compose.yml) sets `TODOIST_API_KEY` and
nothing else — `HOST` and `PORT` fall back to the defaults above. Its single
`ports:` line is the one thing worth editing: it decides who can reach the server.

---

## Host checking

Upstream validates the `Host` (and `Origin`) header on `/mcp` against a trusted
allowlist, as DNS-rebinding protection, and answers **403** on a mismatch. It has
no wildcard and no off switch, so with `HOST=0.0.0.0` every client hostname must
be listed explicitly.

This image removes that friction deliberately. [`entrypoint.mjs`](entrypoint.mjs)
runs the server on `127.0.0.1:PORT+1` with an empty host allowlist (loopback
requests are never rejected) and serves the public port through a small proxy
that rewrites `Host` to `localhost` and drops `Origin`. The effect: **any hostname
or address a client uses works**, with no `ALLOWED_HOSTS` to maintain. Setting
`ALLOWED_HOSTS` has no effect.

The trade-off is real: **DNS-rebinding protection is effectively disabled.**
Exposure control is yours — see [Security notes](#security-notes).

---

## Endpoints

| Path | Method | Notes |
|---|---|---|
| `/mcp` | Streamable HTTP | The MCP endpoint. |
| `/health` | GET | Liveness probe. |

---

## Access control

**This image enforces no access policy.** It runs upstream as-is, so every tool —
including create, update, reschedule and delete — is available.

Access control belongs to the consuming client. Gateways that filter on MCP
annotations can key off the read tools' `readOnlyHint: true`; others allowlist or
denylist by tool name. Tool names come from upstream and can change between
releases, so re-check any allowlist when you bump `TODOIST_MCP_VERSION`.

---

## Connecting a client

Any MCP client that supports Streamable HTTP works.

- **URL:** `http://<host>:3000/mcp`
- **Auth header:** none. The server authenticates *to* Todoist; it does not
  authenticate inbound requests. Do not send an empty bearer token.
- **Host header:** anything. The proxy rewrites it.

From another container, use the service name (e.g. `http://todoist-mcp:3000/mcp`)
— both containers simply need to share a network.

---

## Security notes

- **The shipped compose publishes on every interface.** The `"3000:3000"` line in
  [`docker-compose.yml`](docker-compose.yml) binds `0.0.0.0`, so anyone who can
  reach the host's port 3000 reaches the server. Use `"127.0.0.1:3000:3000"` unless
  you intend remote access.
- **There is no inbound authentication.** Anyone who can reach `/mcp` gets the
  full tool surface, running with your Todoist account.
- **Host checking is disabled by design.** Upstream's DNS-rebinding guard is
  bypassed by the proxy in [`entrypoint.mjs`](entrypoint.mjs), so any hostname
  reaches the server. Put real authentication in front of it if the port is
  reachable from an untrusted network.
- **Non-root.** Runs as the `node` user (uid 1000).
- **Secrets stay at runtime.** The API key is an environment variable, never a
  build argument or a layer.
- **Pinned upstream version.** An image tag tells you exactly what is inside and
  lets you roll back.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `docker compose up` cannot find the image | The package is private (log in to GHCR) or that version was never published. |
| Container starts, then exits or restart-loops | `TODOIST_API_KEY` is empty. The log line is `TODOIST_API_KEY environment variable is required`. |
| Connection refused from another container | The containers are not on a shared network, or the port is not published. |
| 401 from Todoist | Wrong key, or the variable is named `TODOIST_API_TOKEN` instead of `TODOIST_API_KEY`. |
| Client connects but sees no tools | MCP handshake failed — check the container logs for an auth error at startup. |

---

## Base image and size

Based on **Alpine Linux** with the official **Node.js** runtime
([`node:${NODE_VERSION}-alpine`](Dockerfile:11)). `NODE_VERSION` defaults to
`24` because upstream declares `engines.node: ">=24"`.

Measured: the base is ~236 MB and the installed module adds ~92 MB, for an image
of **~340 MB**. Any Node-based image floors near that, so "minimal" here means
shaving everything that is not the runtime.

Deleting `npm`, `corepack` or `yarn` in a later `RUN` layer disables them at
runtime but does **not** shrink the image — base layers are immutable, so those
bytes are still stored and pulled. Real savings need a multi-stage build whose
**final** stage starts from an image that never contained them.

| Option | Approx size | Shell + `wget` |
|---|---|---|
| **Current** — `node:24-alpine` | ~340 MB (measured) | yes |
| Multi-stage on bare Alpine | ~210 MB (est.) | yes |
| Distroless `nodejs24-debian12` | ~230 MB (est.) | no — healthcheck needs a Node one-liner |
| `scratch` + node binary | ~200 MB (est.) | no — no shell |

The current base is kept on purpose: it is the simplest option that keeps a shell
for debugging and BusyBox `wget` for the healthcheck. The smaller options change
the runtime layout and should be smoke-tested before use.

---

## License

MIT — see [LICENSE](LICENSE). This image packages upstream software; the Todoist
MCP server itself is licensed by its authors.