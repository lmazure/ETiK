#!/bin/bash
# Egress allowlist for the ETiK dev container.
#
# Goal: with Claude Code running --dangerously-skip-permissions against untrusted
# web content, default-deny all outbound traffic and permit only what is needed:
# the Anthropic API + auth, the npm registry, GitHub, DNS, and the host gateway
# (the app under test). This bounds the blast radius of a prompt-injection: even
# if the agent is talked into exfiltrating something, it has nowhere to send it.
#
# Requires: NET_ADMIN + NET_RAW capabilities (set in devcontainer.json runArgs)
# and the packages iptables, ipset, dnsutils (dig), aggregate, jq, curl.
#
# Re-run on every container start (devcontainer postStartCommand): iptables rules
# do not persist across restarts.

set -euo pipefail
IFS=$'\n\t'

echo "== ETiK firewall: applying egress allowlist =="

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

# 2a. GitHub IP ranges (web + api + git), IPv4 only.
echo "Fetching GitHub IP ranges..."
gh_ranges=$(curl -fsSL --connect-timeout 10 https://api.github.com/meta || true)
if [ -n "$gh_ranges" ] && echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null 2>&1; then
    while read -r cidr; do
        [[ "$cidr" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || continue
        ipset add allowed-domains "$cidr" 2>/dev/null || true
    done < <(echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' \
                | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' \
                | aggregate -q 2>/dev/null \
              || echo "$gh_ranges" | jq -r '(.web + .api + .git)[]' \
                | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$')
    echo "  GitHub ranges added."
else
    echo "  WARNING: could not fetch/parse GitHub ranges; skipping (git over GitHub may fail)."
fi

# 2b. Resolve and add the remaining allowed domains.
#     - Anthropic API + telemetry: model traffic from Claude Code
#     - claude.ai + console.anthropic.com: browser OAuth login flow
#     - registry.npmjs.org: npm / playwright-cli skill install
#     NOTE: these are CDN-fronted (Cloudflare etc.) so their IPs rotate. We
#     resolve once at start; if login/API calls start failing intermittently,
#     just re-run this script (sudo /usr/local/bin/init-firewall.sh) to refresh.
for domain in \
    api.anthropic.com \
    console.anthropic.com \
    claude.ai \
    statsig.anthropic.com \
    statsig.com \
    sentry.io \
    registry.npmjs.org ; do
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
# 2c. ADD YOUR TEST TARGETS HERE
# ---------------------------------------------------------------------------
# Local apps reached via host.docker.internal are handled in section 3 below.
# If you exploratory-test a PUBLIC site, add its domain to the loop above.
# Be aware: every domain you allow is also a potential exfiltration channel,
# so keep this list as small as the task needs.

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
if curl --connect-timeout 5 -fsS https://api.github.com/zen >/dev/null 2>&1; then
    echo "OK: allowlisted egress works (api.github.com reachable)."
else
    echo "WARNING: api.github.com not reachable — allowlist may need refreshing."
fi

echo "== ETiK firewall: done =="
