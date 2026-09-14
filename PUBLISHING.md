# Building and publishing the image

Goal: your own Todoist MCP image at
`ghcr.io/<your-account>/todoist-mcp:<upstream-version>`, built in GitHub and
pulled by your server. No local build step required.

A Dockerfile is a recipe; a **registry** is where the built artifact lives. GHCR
is a registry attached to your GitHub account, and Actions can push to it with
the built-in `GITHUB_TOKEN`, so you never create or store a credential.

---

## What's in this folder

```
Dockerfile                            # the recipe
entrypoint.mjs                        # proxy entrypoint (host-check bypass)
.dockerignore                         # keeps secrets/build noise out of the context
.github/workflows/publish.yml         # tag -> build (amd64) -> push to GHCR
.github/workflows/release.yml         # -> GitHub Release (once publish succeeds)
.github/workflows/upstream-check.yml  # weekly: is the pinned version stale?
docker-compose.yml                    # runs the published image (tracks :latest)
.env.example                          # the one variable that is required (NEVER the real key)
README.md                             # configuration, endpoints, access control
PUBLISHING.md                         # this file
LICENSE                               # MIT
AGENTS.md                             # guidance for agents working in this repo
docs/MAINTAINER-NOTES.md              # design decisions, verified facts, limitations
```

This folder is the repo root: the workflows must sit at `.github/workflows/`, and
[`publish.yml`](.github/workflows/publish.yml) builds with context `.`, so the
Dockerfile belongs at the root too.

The image name is not chosen by hand — `publish.yml` sets
`IMAGE_NAME: ${{ github.repository }}`, so the package is named after the
repository.

---

## One-time setup

1. **Create the repo and push.**

   ```bash
   git init
   git add .
   git commit -m "Todoist MCP container image"
   git branch -M main
   git remote add origin git@github.com:<your-account>/todoist-mcp.git
   git push -u origin main
   ```

   The image source label is filled in by CI from the repository. For local
   builds, set `--build-arg IMAGE_SOURCE=...` if you want provenance to be exact.

2. **Confirm Actions is enabled** (Settings → Actions → General).

3. **Dry run first.** Actions → *publish* → **Run workflow** with the default
   version. It builds and pushes without creating a tag, so a broken pipeline
   costs nothing.

4. **Decide package visibility.** Packages default to private; public means
   anyone can pull it and hosts need no credentials. Private means a host must
   `docker login ghcr.io` with a `read:packages` PAT.

---

## Releasing

An upstream bump is two edits to the repo — the pin and the tag — plus a pull on
the host to actually run it.

```bash
# 1. bump TODOIST_MCP_VERSION in the Dockerfile, then:
git commit -am "Bump todoist-mcp to 13.2.6"
git push

# 2. tag and push — THIS triggers the build
git tag v13.2.6
git push origin v13.2.6

# 3. to run that release (the compose file tracks :latest, so no edit is needed):
docker compose pull
docker compose up -d
```

The tag `v13.2.6` becomes image tag `13.2.6` — the bare upstream version, no `v`.
`latest` is published too. (A `workflow_dispatch` run publishes the version tag
but not `latest`; only a tag push does.)

Be deliberate about `latest`: it is a moving tag that always points at the newest
release, and the committed compose file tracks it, so a `pull` is all it takes to
upgrade — and all it takes to lose track of what you are running. Pin the version
tag in the compose file when you need a fixed answer or a rollback.

Triggering on tag pushes makes a release a git object: auditable, revertable, and
impossible to produce by accident from a half-finished tree.

After a bump, re-run the check in [Verifying what you published](#verifying-what-you-published):
a `/mcp` request with a hostile `Host` must still answer **401**, not **403**. The
proxy entrypoint depends on upstream behaviour that a green CI build cannot check
— see [`docs/MAINTAINER-NOTES.md`](docs/MAINTAINER-NOTES.md).

### Releases vs tags

A **GitHub Release** is notes attached to a tag. It is not what builds the image;
the **tag push** is. So a Release attached to a tag that already exists fires no
push event and rebuilds nothing — the image stays as it was.

This bites when a tag was pushed before the change it should contain. The image is
then stale and no Release will fix it; move the tag:

```bash
git tag -d v13.2.6
git push origin :refs/tags/v13.2.6    # delete the remote tag
git tag v13.2.6                       # re-create it at HEAD
git push origin v13.2.6               # this is what fires publish.yml
```

Re-pushing an existing image tag overwrites it in GHCR, so the old image is
replaced rather than left as a duplicate. Only do this while nothing has been
deployed from that tag.

Two rules the workflow enforces by pattern, not by validation:

- **The tag must start with `v`** ([`publish.yml`](.github/workflows/publish.yml:8)
  matches `v*`). A tag named `13.2.6` builds nothing.
- **The tag must equal `TODOIST_MCP_VERSION` in the Dockerfile.** Tag `v13.2.6`
  around a `13.2.5` pin publishes an image whose tag misdescribes its contents,
  which is the one thing the tag is supposed to guarantee.

### Publishing a Release

[`release.yml`](.github/workflows/release.yml) writes the Release, so no `gh`
install and no token are involved — `GITHUB_TOKEN` is injected into the run.

- **Automatic:** it triggers on `publish` *completing*, so a version tag that
  builds successfully gets a Release. A failed build gets none, because a Release
  is a claim that the image exists.
- **Manual:** Actions → *release* → *Run workflow* with a tag (e.g. `v13.2.5`).
  This is the path for a tag that predates the workflow, such as the first one.

Notes are generated from the commit history. Edit the Release body afterwards to
add anything curated — editing a Release creates no tag and triggers no build.

---

## Platforms (amd64 only, for now)

Built for **`linux/amd64`** only.

arm64 is not built because the obvious approach — listing `linux/arm64` and
letting Buildx emulate it with QEMU — fails: Node's `npm` crashes with **SIGILL**
(`exit code 132`) under arm64 emulation. Treat QEMU as unusable for this image.

The reliable path is a native ARM runner. GitHub provides `ubuntu-24.04-arm`,
which is free for public repos. The shape is:

1. a build matrix — `linux/amd64` on `ubuntu-latest`, `linux/arm64` on
   `ubuntu-24.04-arm`;
2. each leg pushes by digest (`outputs: type=image,push-by-digest=true`);
3. a final job merges the digests with `docker buildx imagetools create`.

That yields a single tag covering both architectures, so `docker pull` selects
the right layers on either host.

---

## Where the credential comes from

- **Pushing to GHCR** uses `secrets.GITHUB_TOKEN`, injected into every run. The
  `packages: write` permission is what authorises it. No PAT, nothing to rotate.
- **The Todoist API key never touches the pipeline.** It is injected at runtime
  on your host via `.env`. The image is identical for everyone; only the
  environment differs.

If you ever find yourself adding a Todoist key to the repo, stop and reconsider.

---

## Verifying what you published

```bash
docker run --rm --entrypoint id ghcr.io/<your-account>/todoist-mcp:13.2.6   # non-root?
docker history ghcr.io/<your-account>/todoist-mcp:13.2.6                    # what got installed?

docker run --rm -e TODOIST_API_KEY=<key> -p 3000:3000 \
  ghcr.io/<your-account>/todoist-mcp:13.2.6
curl -s localhost:3000/health
```

Then confirm the proxy entrypoint is in place: a `/mcp` request carrying
`Host: evil.example.com` should answer **401** (Todoist auth) — **403** means
upstream's host check is still rejecting, i.e. the proxy is not running:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Host: evil.example.com' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  localhost:3000/mcp
```

Also worth doing once: `docker scout quickview` (or `trivy image`) on the
published tag. The full verification log is in
[docs/MAINTAINER-NOTES.md](docs/MAINTAINER-NOTES.md).

---

## Deploying it

[`docker-compose.yml`](docker-compose.yml) already runs the published image —
there is no `build:` to swap out. Deploying is a pull:

```bash
docker compose pull
docker compose up -d
```

The committed file tracks `:latest`, so this always moves you to the newest
release with no edit; the cost is that the file no longer tells you what you are
running. Pin a version tag (`ghcr.io/<your-account>/todoist-mcp:13.2.6`) when you
want that. The file names this repository's registry, so a fork must change that
one line.

Until the first publish has completed there is nothing to pull — build locally
for that window (see [Fallback: build locally](#fallback-build-locally)).

If the package is private, log in once on the host:

```bash
echo <PAT-with-read:packages> | docker login ghcr.io -u <your-account> --password-stdin
```

---

## Keeping it fresh

`upstream-check.yml` runs weekly and opens an issue when npm has a newer
`@doist/todoist-mcp`. That is the signal to cut a new tag.

**Caveat:** a new upstream release can rename or add tools. If you rely on a tool
allowlist downstream (for example a read-only subset), re-check it on every bump
— a renamed tool that is no longer allowed fails quietly, not loudly.

---

## Fallback: build locally

Only if CI is broken and you need an image now:

```bash
docker build --build-arg TODOIST_MCP_VERSION=13.2.6 \
  -t ghcr.io/<your-account>/todoist-mcp:13.2.6 .
```

Prefer the pipeline: a local build leaves no record of what went into it.