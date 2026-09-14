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
.dockerignore                         # keeps secrets/build noise out of the context
.github/workflows/publish.yml         # tag -> build (amd64) -> push to GHCR
.github/workflows/upstream-check.yml  # weekly: is the pinned version stale?
docker-compose.yml                    # how a host runs the image
.env.example                          # API key placeholder (NEVER the real key)
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

```bash
# 1. bump TODOIST_MCP_VERSION in the Dockerfile, then:
git commit -am "Bump todoist-mcp to 13.2.6"
git push

# 2. tag and push — THIS triggers the build
git tag v13.2.6
git push origin v13.2.6
```

The tag `v13.2.6` becomes image tag `13.2.6`, and `latest` is published too.
**Never deploy `latest`** — you lose the ability to know what you are running or
to roll back. (A `workflow_dispatch` run publishes the version tag but not
`latest`; only a tag push does.)

Triggering on tag pushes makes a release a git object: auditable, revertable, and
impossible to produce by accident from a half-finished tree.

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

Also worth doing once: `docker scout quickview` (or `trivy image`) on the
published tag.

---

## Deploying it

Swap `build: .` in [`docker-compose.yml`](docker-compose.yml) for the published
image:

```yaml
services:
  todoist-mcp:
    image: ghcr.io/<your-account>/todoist-mcp:13.2.6   # pinned, not :latest
```

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