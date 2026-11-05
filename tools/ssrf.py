#!/usr/bin/env python3
"""SSRF-hardened fetch for the ingest source lane (stdlib-only, synchronous).

A synchronous mirror of ~/deltos-backend/app/ssrf.py's policy, dropped into the
stdlib CLI toolchain unchanged. The guard closes the SSRF gap in
`tools/ingest-source.py` (the one-liner -> INGEST.md / feed / API fetch):

- ONLY http/https; block URL userinfo, CR/LF (raw + percent-encoded), and
  non-default ports (80/443 only — a narrow allowlist, not a blacklist).
- DNS-resolve the hostname and REJECT if ANY resolved address is not globally
  routable (private/loopback/link-local/multicast/reserved/unspecified/ULA are
  all denied via `ipaddress.is_global`).
- Re-resolve on EVERY redirect hop (defeats DNS rebinding); max 3 redirects; a
  redirect to a private address is rejected before connecting.
- Response size cap; connect/read timeouts.

The fetch pins the validated IP: the connection opens to the resolved IP while
the Host header and TLS SNI carry the real hostname, so no HTTP library can
re-resolve the name underneath us. `http.client` handles chunked/Content-Length
correctly (gzip is never requested, so servers answer identity — same as the
previous urllib path).
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import sys
import urllib.parse

MAX_BYTES = 8 * 1024 * 1024   # align with ingest-source.py's bomb defence
CONNECT_TIMEOUT = 10.0
TOTAL_TIMEOUT = 20.0
MAX_REDIRECTS = 3
ALLOWED_PORTS = {80, 443}

USER_AGENT = "ingest/0.1 (+https://github.com/justinsharpe/ingest)"

_REDIRECT_CODES = {301, 302, 303, 307, 308}


class SSRFError(Exception):
    """Any policy violation or transport failure during fetch."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def validate_ip(ip_str: str) -> bool:
    """True iff `ip_str` is a globally routable unicast address."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return bool(ip.is_global)


def parse_url(url: str) -> urllib.parse.SplitResult:
    """Validate the URL shape for outbound fetch; raise SSRFError on violation."""
    if "\r" in url or "\n" in url:
        raise SSRFError("URL contains CR/LF")
    lower = url.lower()
    if "%0d" in lower or "%0a" in lower:
        raise SSRFError("URL contains percent-encoded CR/LF")
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as exc:
        raise SSRFError("malformed URL: %s" % exc) from exc
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise SSRFError("scheme %r not allowed (http/https only)" % parsed.scheme)
    if parsed.username is not None or parsed.password is not None:
        raise SSRFError("URL userinfo not allowed")
    if not parsed.hostname:
        raise SSRFError("URL has no host")
    try:
        port = parsed.port
    except ValueError as exc:
        raise SSRFError("invalid port: %s" % exc) from exc
    if port is not None and port not in ALLOWED_PORTS:
        raise SSRFError("port %d not allowed (80/443 only)" % port)
    return parsed


def resolve_host(host: str) -> list:
    """Resolve host -> unique addresses (A + AAAA), order-preserving."""
    addrs = []
    try:
        infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SSRFError("host %r did not resolve: %s" % (host, exc)) from exc
    for info in infos:
        addr = info[4][0]
        if addr not in addrs:
            addrs.append(addr)
    return addrs


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that connects to a pre-validated IP, not the hostname."""

    def __init__(self, ip: str, host: str, port: int, timeout: float):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection pinned to a validated IP; SNI still uses the hostname."""

    def __init__(self, ip: str, host: str, port: int, timeout: float):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)
        if self._tunnel_host:
            self._tunnel()
        server_hostname = self.host if ssl.HAS_SNI else None
        self.sock = self._context.wrap_socket(self.sock, server_hostname=server_hostname)


def _request_once(url, ip, host, port, scheme, *, total_timeout, max_bytes):
    parsed = urllib.parse.urlsplit(url)
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    if scheme == "https":
        conn = _PinnedHTTPSConnection(ip, host, port, timeout=total_timeout)
    else:
        conn = _PinnedHTTPConnection(ip, host, port, timeout=total_timeout)

    try:
        conn.request("GET", path, headers={
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Connection": "close",
        })
        resp = conn.getresponse()
        status = resp.status
        headers = {k.lower(): v for k, v in resp.getheaders()}
        body = resp.read(max_bytes + 1)
    except (socket.timeout, TimeoutError) as exc:
        raise SSRFError("timeout") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise SSRFError("fetch failed: %s" % exc) from exc
    finally:
        conn.close()

    if len(body) > max_bytes:
        raise SSRFError("response exceeds %d bytes" % max_bytes)
    return status, headers, body


def safe_fetch(url, *, max_bytes=MAX_BYTES, connect_timeout=CONNECT_TIMEOUT,
               total_timeout=TOTAL_TIMEOUT, max_redirects=MAX_REDIRECTS):
    """Fetch `url` under SSRF policy. Returns (status_code, headers, body).

    Raises SSRFError for policy violations (scheme/userinfo/CR-LF/port/private
    address/too many redirects/size cap) and for transport failures.
    """
    current = url
    for _ in range(max_redirects + 1):
        parsed = parse_url(current)
        scheme = parsed.scheme.lower()
        host = parsed.hostname
        port = parsed.port or (443 if scheme == "https" else 80)

        addrs = resolve_host(host)
        if not addrs:
            raise SSRFError("host %r did not resolve" % host)
        for a in addrs:
            if not validate_ip(a):
                raise SSRFError("host %r resolves to non-public address %s" % (host, a))

        status, headers, body = _request_once(
            current, addrs[0], host, port, scheme,
            total_timeout=total_timeout, max_bytes=max_bytes,
        )
        if status in _REDIRECT_CODES:
            location = headers.get("location")
            if not location:
                return status, headers, body
            current = urllib.parse.urljoin(current, location)
            continue
        return status, headers, body

    raise SSRFError("too many redirects (>%d)" % max_redirects)


def _main(argv):
    if len(argv) >= 3 and argv[1] == "check-ip":
        ok = validate_ip(argv[2])
        print("public" if ok else "private")
        return 0 if ok else 1
    if len(argv) >= 3 and argv[1] == "check-url":
        try:
            parse_url(argv[2])
            print("ok")
            return 0
        except SSRFError as exc:
            print("refused: %s" % exc.reason)
            return 1
    print("usage: ssrf.py check-ip <ip> | check-url <url>", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
