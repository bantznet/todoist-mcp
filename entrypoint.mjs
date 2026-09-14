#!/usr/bin/env node
//
// Entrypoint: front `todoist-mcp-http` with a tiny reverse proxy.
//
// Upstream rejects requests whose `Host` (or `Origin`) is not in a trusted
// allowlist — DNS-rebinding protection. That guard is a good default for a
// loopback dev server, but this image is meant to be reachable by whatever MCP
// client the operator runs, by whatever name or address they use. So instead of
// making every deployment enumerate hostnames, the proxy binds the public port,
// runs the server on loopback, and rewrites `Host` to `localhost` (always
// trusted) while dropping `Origin` (absent means allowed).
//
// Consequence: the DNS-rebinding guard is effectively disabled. Exposure
// control is the operator's job — keep it on a trusted network or behind
// authentication. See "Host checking" in README.md.
//
//   public HOST:PORT  ->  proxy  ->  127.0.0.1:(PORT+1)  ->  todoist-mcp-http

import http from 'node:http'
import { spawn } from 'node:child_process'

const publicHost = process.env.HOST || '0.0.0.0'
const publicPort = Number.parseInt(process.env.PORT || '3000', 10)
const internalPort = publicPort + 1

// Run upstream on loopback with an empty host allowlist: loopback requests are
// never rejected, whatever `Host` says. `todoist-mcp-http` exits 1 on a missing
// API key; that propagates.
const child = spawn('todoist-mcp-http', process.argv.slice(2), {
    env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(internalPort),
        ALLOWED_HOSTS: '',
    },
    stdio: 'inherit',
})
// A stop request is a normal way for this process to end, so it must not exit
// with a failure code: `docker stop` reports the exit code, and a 1 there reads
// as a crash. Report the conventional 128+signum instead (143 for SIGTERM, 130
// for SIGINT).
const SIGNAL_CODES = { SIGTERM: 143, SIGINT: 130 }
let forwarded = null

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        forwarded = signal
        child.kill(signal)
    })
}

child.on('exit', (code, signal) => {
    if (forwarded) process.exit(SIGNAL_CODES[forwarded])
    process.exit(code ?? (signal ? 1 : 0))
})

// Hop-by-hop headers must not be forwarded, and `origin` is dropped on purpose.
const SKIP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'expect',
    'origin',
])

function forwardable(headers, overrides = {}) {
    const out = {}
    for (const [name, value] of Object.entries(headers)) {
        if (!SKIP.has(name.toLowerCase())) out[name] = value
    }
    return { ...out, ...overrides }
}

const proxy = http.createServer((req, res) => {
    const upstream = http.request(
        {
            host: '127.0.0.1',
            port: internalPort,
            method: req.method,
            path: req.url,
            headers: forwardable(req.headers, { host: 'localhost' }),
        },
        (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode || 502, forwardable(upstreamRes.headers))
            upstreamRes.pipe(res)
        },
    )

    upstream.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
        res.end(`upstream unavailable: ${error.message}\n`)
    })

    req.pipe(upstream)
})

proxy.on('error', (error) => {
    console.error(`proxy: cannot listen on ${publicHost}:${publicPort}: ${error.message}`)
    child.kill('SIGTERM')
    process.exit(1)
})

// Only start accepting traffic once the server answers /health, so early
// requests get a connection rather than a 502.
const probe = () =>
    new Promise((resolve, reject) => {
        const request = http.request(
            { host: '127.0.0.1', port: internalPort, path: '/health' },
            (response) => {
                response.resume()
                resolve()
            },
        )
        request.on('error', reject)
        request.end()
    })

for (let attempt = 0; attempt < 100; attempt++) {
    try {
        await probe()
        break
    } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
}

proxy.listen(publicPort, publicHost, () => {
    console.error(
        `proxy: ${publicHost}:${publicPort} -> 127.0.0.1:${internalPort} ` +
            '(upstream host check bypassed; exposure control is yours)',
    )
})