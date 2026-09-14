# Design and decision notes

> The reasoning behind this project: decisions, the facts they rest on, and known
> limitations. Complements [`README.md`](../README.md) (behaviour) and
> [`PUBLISHING.md`](../PUBLISHING.md) (build and release).
>
> **No secrets** — never commit a Todoist API key or a registry PAT.

## What this is

A non-root container image for the official Todoist MCP server
([`@doist/todoist-mcp`](https://github.com/Doist/todoist-mcp)), served over
Streamable HTTP and published to GHCR.

- Repo: `github.com/bantznet/todoist-mcp`
- Image: `ghcr.io/bantznet/todoist-mcp:<upstream-version>`

The image name follows the repository — [`publish.yml`](../.github/workflows/publish.yml)
sets `IMAGE_NAME: ${{ github.repository }}`.

## Decisions

| Decision | Why |
|---|---|
| Gateway-agnostic | Reusable by any MCP client, not one gateway. |
| HTTP only (no stdio) | Simpler. |
| **Not** read-only | Exposes the full upstream tool surface; access control is the client's job. |
| `node:24-alpine` | Upstream declares `engines.node: ">=24"`. Node 22 ran but warned `EBADENGINE`; matching the floor prevents a silent break on a dependency bump. Costs ~3 MB. |
| `linux/amd64` only | Node's `npm` crashes with SIGILL (`exit code 132`) under QEMU arm64 emulation; arm64 needs a native ARM runner (recipe in [`PUBLISHING.md`](../PUBLISHING.md)). |
| GHCR, not Docker Hub | Built-in `GITHUB_TOKEN`; no second account or PAT. |
| Tag mirrors upstream version | An image tagged `X` contains upstream `X`, so tags are auditable and revertable. |
| Compose runs the published image | [`docker-compose.yml`](../docker-compose.yml) has no `build:`, so there is one source of truth — the published image — instead of a local build that can drift from what CI published. It tracks `:latest` so an upgrade is a `pull` with no file edit. The trade-off is deliberate: reproducibility then depends on pinning the tag yourself, so a deploy-time rollback needs a file change first. |
| Release after the build, not on the tag | [`release.yml`](../.github/workflows/release.yml) triggers on [`publish.yml`](../.github/workflows/publish.yml) completing, so a failed build cannot leave a Release claiming the version is available. Notes are generated rather than stored, so there is no per-release file to maintain; a manual dispatch covers tags that predate the workflow. |
| Compose sets only the API key | `HOST`, `PORT`, `BIND_ADDR` and `HOST_PORT` were placeholders whose defaults were already the image defaults. Cutting them leaves the one line that is genuinely worth editing (the published port) instead of several that look configurable but change nothing. |
| Proxy entrypoint ([`entrypoint.mjs`](../entrypoint.mjs)) | Upstream's `ALLOWED_HOSTS` guard has no wildcard and no off switch, so every deployment would otherwise have to enumerate the hostnames its clients use. The proxy binds the public port and rewrites `Host`/`Origin` instead. Costs one internal port and deliberately disables DNS-rebinding protection. |

## Verified facts

Established by inspecting the npm package and running the image — a green CI
build proves none of them:

1. **`todoist-mcp-http` is a real bin** — the `bin` field of
   `@doist/todoist-mcp@13.2.5` maps it to `dist/main-http.js`, so the
   `ENTRYPOINT` is correct.
2. **Env vars:** `TODOIST_API_KEY` (required; exits 1 if unset), `HOST` (default
   `127.0.0.1`), `PORT` (default `3000`), `ALLOWED_HOSTS`, plus undocumented
   `TODOIST_BASE_URL` and `USE_STRUCTURED_CONTENT`. No `_TOKEN` anywhere.
3. **`ALLOWED_HOSTS` matches hostname only** — the port is stripped from both the
   list and the request. `/health` skips the check, so the healthcheck stays
   valid whatever hostname a client uses.
4. **An empty allowlist still answers loopback.** The entrypoint sets
   `ALLOWED_HOSTS=''` and binds upstream to `127.0.0.1`; requests rewritten to
   `Host: localhost` are answered — **401** from Todoist auth, not **403**. That is
   the mechanism the bypass rests on. If upstream ever tightens it the failure is
   loud (`/mcp` 403s for everyone), not silent.
5. **`13.2.5` exists** and was npm's `latest` at the time of writing.

Reproduce — the entrypoint, its binary name and the environment variables are
only proven by running the container:

```bash
# dist-tags (tarball package.json gives bin + engines; dist/main-http.js gives env vars)
curl -s https://registry.npmjs.org/@doist/todoist-mcp | \
  python3 -c "import sys,json;print(json.load(sys.stdin)['dist-tags'])"
# -> {'latest': '13.2.5'}

docker build -t todoist-mcp:local .
docker run -d --name tmcp-test -e TODOIST_API_KEY=dummy \
  -p 127.0.0.1:13000:3000 todoist-mcp:local
docker logs tmcp-test   # upstream on 127.0.0.1:3001, then the proxy on 0.0.0.0:3000

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/health   # 200
# POST /mcp with a dummy key -> 401 (Todoist auth), and 401 again with
# `Host: evil.example.com` or `Origin: https://evil.example.com`. A 403 would mean
# the bypass is not working. Passing `-e ALLOWED_HOSTS=nope.example` changes
# nothing — it is ignored. GET /mcp -> 405.
docker exec tmcp-test id -u                                              # 1000
docker inspect --format '{{.State.Health.Status}}' tmcp-test             # healthy
docker stop tmcp-test >/dev/null
docker inspect --format '{{.State.ExitCode}}' tmcp-test                  # 143
docker run --name tmcp-nokey todoist-mcp:local; echo $?                  # 1, no API key
docker images --format '{{.Size}}' todoist-mcp:local                     # 339MB

# The compose file needs no build context:
TODOIST_API_KEY=dummy docker compose config -q                           # valid
docker tag todoist-mcp:local ghcr.io/bantznet/todoist-mcp:latest
docker compose up -d && curl -s localhost:3000/health                    # 200
```

Measured on Node 24 with upstream 13.2.5: the server answers on
`127.0.0.1:3001`; `/health` is **200**; `/mcp` with a hostile `Host` or `Origin`
is **401 rather than 403**; the container is uid **1000**; `docker stop` exits
**143** (a clean stop, not a failure); a missing API key exits **1** in ~3s; the
image is **339 MB**.

The compose check above re-tags a local build as `:latest`, so it proves the file
works with no build context without needing registry access. What it cannot prove
offline is the **pull**: the first `docker compose up` still depends on
`publish.yml` having pushed that tag, and on `docker login` if the package is
private. Treated as a known window between first push and first release.

Measured size: `node:24-alpine` ~236 MB + module ~92 MB = **~339 MB** image
(`node:22-alpine` is ~232 MB, so Node 24 costs ~3 MB).

## Limitations

- **amd64 only** — arm64 needs a native ARM runner; QEMU is unusable (see above).
- **No tool filtering** — the full surface, including delete, is exposed.
- **DNS-rebinding protection is disabled by design** — the proxy rewrites
  `Host`/`Origin`, so any hostname reaches the server and `ALLOWED_HOSTS` has no
  effect. Keep the port on a trusted network or behind authentication.
- **No inbound authentication** — anyone who can reach the port gets the full
  tool surface, running with your Todoist account. The shipped compose publishes
  `3000:3000`, i.e. on every interface; narrowing that line is the operator's job.
- **The compose file names one registry** — `ghcr.io/bantznet/todoist-mcp`. A fork
  must edit that line before it can pull anything.
- **Tool names can change upstream** — re-check any downstream allowlist when
  bumping `TODOIST_MCP_VERSION`; `upstream-check.yml` flags available bumps.
