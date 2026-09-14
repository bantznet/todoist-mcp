# todoist-mcp

**Unofficial container image for the official Todoist MCP server
([`@doist/todoist-mcp`](https://github.com/Doist/todoist-mcp)), served over
Streamable HTTP.**

Upstream ships to npm only — there is no official image. This packages that
release as a small, non-root container any MCP client that speaks Streamable HTTP
can connect to. It is deliberately generic: no orchestrator, network or
tool-policy assumptions. It exposes the full upstream server (read **and** write
tools); deciding what a client should use is the client's job.

| | |
|---|---|
| **Image** | `ghcr.io/<your-account>/todoist-mcp:<upstream-version>` |
| **Upstream** | [`Doist/todoist-mcp`](https://github.com/Doist/todoist-mcp) |
| **Transport** | Streamable HTTP — `/mcp` (probe at `/health`) |
| **Platforms** | `linux/amd64` (arm64 needs a native ARM runner — see [PUBLISHING.md](PUBLISHING.md)) |
| **Base** | `node:24-alpine`, runs as non-root `node` |

**Jump to:** [Quick start](#quick-start) · [Configuration](#configuration) ·
[Endpoints](#endpoints) · [Access control](#access-control) ·
[Connecting a client](#connecting-a-client) · [Security](#security-notes) ·
[Troubleshooting](#troubleshooting)

---

## Quick start

Create an API key in Todoist under **Settings → Integrations → Developer** and
treat it like a password.

**Docker Compose**

```bash
cp .env.example .env          # paste your API key into .env
docker compose up -d --build
docker compose logs -f todoist-mcp
```

**docker run**

```bash
docker run -d --name todoist-mcp \
  -e TODOIST_API_KEY=<your-api-key> \
  -e HOST=0.0.0.0 \
  -e ALLOWED_HOSTS=localhost,127.0.0.1 \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/<your-account>/todoist-mcp:<upstream-version>
```

`ALLOWED_HOSTS` must list every hostname clients use, or `/mcp` returns 403 (the
compose file supplies a default). To build the image yourself, see
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
| `HOST` | No | `0.0.0.0` | Bind address. Upstream defaults to `127.0.0.1`, which is unreachable outside the container. |
| `PORT` | No | `3000` | Listen port. |
| `ALLOWED_HOSTS` | No | see below | Allowlist of `Host` header hostnames. |
| `TODOIST_BASE_URL` | No | upstream default | Overrides the Todoist API base URL. Rarely needed. |

The compose default for `ALLOWED_HOSTS`:

```
todoist-mcp,todoist-mcp:3000,localhost,localhost:3000,127.0.0.1:3000
```

The server checks the incoming `Host` header against this list as a DNS-rebinding
guard and returns **403 on `/mcp`** on a mismatch. Matching is on the **hostname
only** — the port is stripped from both the list and the request, so
`todoist-mcp` and `todoist-mcp:3000` are equivalent. Override it for your
environment.

---

## Endpoints

| Path | Method | Notes |
|---|---|---|
| `/mcp` | Streamable HTTP | The MCP endpoint. Requires a `Host` in `ALLOWED_HOSTS`. |
| `/health` | GET | Liveness probe. No `Host` check, so it works even when `ALLOWED_HOSTS` is wrong. |

A 200 on `/health` with a 403 on `/mcp` is the signature of an `ALLOWED_HOSTS`
mismatch.

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
- **Host header:** must be listed in `ALLOWED_HOSTS`.

From another container, use the service name (e.g. `http://todoist-mcp:3000/mcp`)
and add that hostname to `ALLOWED_HOSTS`.

---

## Security notes

- **Non-root.** Runs as the `node` user (uid 1000).
- **Secrets stay at runtime.** The API key is an environment variable, never a
  build argument or a layer.
- **Pinned upstream version.** An image tag tells you exactly what is inside and
  lets you roll back.
- **`ALLOWED_HOSTS` is not authentication.** It is a DNS-rebinding guard. If the
  port is reachable from an untrusted network, put a reverse proxy with real
  authentication in front.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `/health` 200 but `/mcp` **403** | `ALLOWED_HOSTS` lacks the hostname your client sends. Add it (the port is ignored). |
| Connection refused from another container | `HOST` left at `127.0.0.1`, or no shared network. |
| 401 from Todoist | Wrong key, or the variable is named `TODOIST_API_TOKEN` instead of `TODOIST_API_KEY`. |
| Client connects but sees no tools | MCP handshake failed — check the container logs for an auth error at startup. |
| Works locally, fails from a gateway | Override `ALLOWED_HOSTS` (and `BIND_ADDR`) for the hostname the gateway uses. |

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