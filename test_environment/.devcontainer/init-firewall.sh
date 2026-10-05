#!/bin/bash
# Egress allowlist for the ETiK dev container.
#
# Goal: with Claude Code running --dangerously-skip-permissions against untrusted
# web content, default-deny all outbound traffic and permit only what is needed.
#
# Requires: NET_ADMIN + NET_RAW capabilities (set in devcontainer.json runArgs)
# and the packages iptables, ipset, dnsutils (dig), curl.
#
# Re-run on every container start (devcontainer postStartCommand): iptables rules
# do not persist across restarts.

set -euo pipefail
IFS=$'\n\t'

echo "== Applying egress allowlist =="

# ---------------------------------------------------------------------------
# 0. Reset
# ---------------------------------------------------------------------------
iptables -F
iptables -X
iptables -t nat -F 2>/dev/null || true
iptables -t nat -X 2>/dev/null || true
iptables -t mangle -F 2>/dev/null || true
iptables -t mangle -X 2>/dev/null || true
ipset destroy allowed-domains 2>/dev/null || true

# ---------------------------------------------------------------------------
# 1. Allow the essentials BEFORE switching the default policy to DROP
# ---------------------------------------------------------------------------
# Loopback
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# DNS (needed to resolve the allowlist below and at runtime)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -j ACCEPT

# ---------------------------------------------------------------------------
# 2. Build the allowed-domains ipset
# ---------------------------------------------------------------------------
ipset create allowed-domains hash:net

# Resolve and add the allowed domains.
#    - Anthropic API: model traffic from Claude Code
#    - claude.ai: browser OAuth login flow + token refresh (Claude subscription)
#    NOTE 1: these are CDN-fronted (Cloudflare etc.) so their IPs rotate. We
#    resolve once at start; if login/API calls start failing intermittently,
#    just re-run this script (sudo /usr/local/bin/init-firewall.sh) to refresh.
#    NOTE 2: this assumes a Claude subscription login. If you instead log in with
#    an Anthropic Console account, add console.anthropic.com back (and you can drop
#    claude.ai).
#    NOTE 3: Claude Code's telemetry hosts (statsig.anthropic.com / sentry.io) are
#    intentionally NOT allowlisted; CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in
#    devcontainer.json stops those calls from even being attempted.
for domain in \
    api.anthropic.com \
    claude.ai \
    tm-en.doc.squashtest.com \
    tm-fr.doc.squashtest.com ; do
    ips=$(dig +short A "$domain" 2>/dev/null || true)
    if [ -z "$ips" ]; then
        echo "  WARNING: failed to resolve $domain (skipping)"
        continue
    fi
    while read -r ip; do
        [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        ipset add allowed-domains "$ip" 2>/dev/null || true
    done < <(echo "$ips")
    echo "  Added $domain"
done

# ---------------------------------------------------------------------------
# 3. Allow the Docker host gateway (the app-under-test on a host port)
# ---------------------------------------------------------------------------
HOST_GATEWAY=$(getent hosts host.docker.internal | awk '{print $1}' | head -n1 || true)
if [ -n "${HOST_GATEWAY:-}" ]; then
    echo "Allowing host gateway $HOST_GATEWAY (host.docker.internal)"
    iptables -A OUTPUT -d "$HOST_GATEWAY" -j ACCEPT
    iptables -A INPUT  -s "$HOST_GATEWAY" -j ACCEPT
else
    echo "WARNING: could not determine host.docker.internal gateway."
fi

# ---------------------------------------------------------------------------
# 4. Flip to default-deny, then permit established + the allowlist
# ---------------------------------------------------------------------------
iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

echo "== Firewall rules applied =="

# ---------------------------------------------------------------------------
# 5. Verify
# ---------------------------------------------------------------------------
# Critical check (hard fail): an off-allowlist host MUST be blocked.
if curl --connect-timeout 5 -fsS https://example.com >/dev/null 2>&1; then
    echo "ERROR: verification failed — example.com is reachable but should be blocked."
    exit 1
fi
echo "OK: off-allowlist egress is blocked (example.com unreachable)."

# Sanity check (warning only, to avoid blocking container start on CDN timing).
# Any HTTP response means the connection went through; we don't need a 2xx, so
# no -f here (an unauthenticated GET to api.anthropic.com won't return 2xx).
if curl --connect-timeout 5 -sS -o /dev/null https://api.anthropic.com 2>/dev/null; then
    echo "OK: allowlisted egress works (api.anthropic.com reachable)."
else
    echo "WARNING: api.anthropic.com not reachable — allowlist may need refreshing."
fi

echo "== Egress allowlist applied =="
