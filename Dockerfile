# syntax=docker/dockerfile:1
#
# Unofficial container image for the official Todoist MCP server
# (@doist/todoist-mcp), served over Streamable HTTP.
#
# Transport-, client- and orchestrator-agnostic: no single gateway or network is
# assumed, and no policy is imposed on which tools a client should use.

# Node 24 is upstream's declared floor (engines.node >=24); do not lower it.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine

# Pin the upstream version. The image tag mirrors this value, so keep the 1:1
# mapping — never publish a tag that disagrees with it.
ARG TODOIST_MCP_VERSION=13.2.5

# CI overrides this with the real repository URL; the default is for local builds.
ARG IMAGE_SOURCE="https://github.com/example/todoist-mcp"

LABEL org.opencontainers.image.title="todoist-mcp" \
      org.opencontainers.image.description="Unofficial container image for the official Todoist MCP server (@doist/todoist-mcp), exposed over Streamable HTTP" \
      org.opencontainers.image.version="${TODOIST_MCP_VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="${IMAGE_SOURCE}"

# Exact version only — no floating range. The build is the version lock.
RUN npm install -g "@doist/todoist-mcp@${TODOIST_MCP_VERSION}" \
 && npm cache clean --force

# Drop root. The `node` user ships with the base image (uid 1000).
#
# No secret appears above: the Todoist API key is a RUNTIME variable. Anything
# baked into a layer is readable by anyone who can pull the image, forever.
USER node

# HOST must be 0.0.0.0 to be reachable from outside the container; the upstream
# default (127.0.0.1) is loopback-only.
ENV HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000

# /health does not check the Host header, so it stays a valid probe even when
# ALLOWED_HOSTS is misconfigured.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

# Runtime configuration (only the API key is required):
#   TODOIST_API_KEY   required, authenticates the server to Todoist
#   HOST / PORT       bind address and port (0.0.0.0:3000 here)
#   ALLOWED_HOSTS     Host header allowlist; hostname-only (port ignored),
#                     /mcp returns 403 on mismatch
#   TODOIST_BASE_URL  optional, overrides the Todoist API base URL
#
# `todoist-mcp-http` is the bundled HTTP-mode binary.
ENTRYPOINT ["todoist-mcp-http"]