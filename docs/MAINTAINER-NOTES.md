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
   list and the request. `/health` skips the check, which is why it stays a
   reliable probe.
4. **`13.2.5` exists** and was npm's `latest` at the time of writing.

Reproduce:

```bash
# dist-tags (tarball package.json gives bin + engines; dist/main-http.js gives env vars)
curl -s https://registry.npmjs.org/@doist/todoist-mcp | \
  python3 -c "import sys,json;print(json.load(sys.stdin)['dist-tags'])"
# -> {'latest': '13.2.5'}

docker build -t todoist-mcp:local .
docker run -d --name tmcp-test -e TODOIST_API_KEY=dummy -e HOST=0.0.0.0 \
  -e ALLOWED_HOSTS=localhost,127.0.0.1 -p 127.0.0.1:13000:3000 todoist-mcp:local
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/health   # 200
# POST /mcp, dummy key -> 401; POST /mcp, Host: evil.example.com -> 403; GET /mcp -> 405
docker exec tmcp-test id -u                                              # 1000
docker inspect --format '{{.State.Health.Status}}' tmcp-test             # healthy
docker images --format '{{.Size}}' todoist-mcp:local                     # 339MB
```

Measured size: `node:24-alpine` ~236 MB + module ~92 MB = **~339 MB** image
(`node:22-alpine` is ~232 MB, so Node 24 costs ~3 MB).

## Limitations

- **amd64 only** — arm64 needs a native ARM runner; QEMU is unusable (see above).
- **No tool filtering** — the full surface, including delete, is exposed.
- **`ALLOWED_HOSTS` is not authentication** — a DNS-rebinding guard only.
- **Tool names can change upstream** — re-check any downstream allowlist when
  bumping `TODOIST_MCP_VERSION`; `upstream-check.yml` flags available bumps.
