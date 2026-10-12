#!/bin/bash
# Egress allowlist of the ETiK test container.
#
# Goal: with Claude Code running --dangerously-skip-permissions against untrusted
# web content, default-deny all outbound traffic and permit only what is needed.
#
# Usage: init-firewall.sh [--domain <name>]... [--host-port <port>]...
#   --domain     an Internet domain to allow, on top of the base ones below
#   --host-port  a TCP port to allow on the Docker host (host.docker.internal)
#
# Without argument, only the base domains are allowed: this is the state of the
# container between two sessions. The ETiK console (running as root) re-runs this
# script with the domains and host ports of the configuration when a session
# starts, and without argument when it ends.
#
# Requires: root, the NET_ADMIN + NET_RAW capabilities (docker-compose.yml) and
# the packages iptables, ipset, dnsutils (dig), curl.

set -euo pipefail
IFS=$'\n\t'

# Always allowed:
#    - api.anthropic.com: model traffic from Claude Code
#    - claude.ai: browser OAuth login flow + token refresh (Claude subscription)
#    NOTE 1: these are CDN-fronted (Cloudflare etc.) so their IPs rotate. We
#    resolve them when the script runs, i.e. at container start and at each
#    session start; if login/API calls start failing intermittently, start a
#    new session to refresh them.
#    NOTE 2: this assumes a Claude subscription login. If you instead log in with
#    an Anthropic Console account, add console.anthropic.com.
#    NOTE 3: Claude Code's telemetry hosts (statsig.anthropic.com / sentry.io) are
#    intentionally NOT allowlisted; CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
#    stops those calls from even being attempted.
BASE_DOMAINS=(api.anthropic.com claude.ai)

# Port of the ETiK console inside the container.
ETIK_PORT="${ETIK_PORT:-7681}"
# The user Claude Code runs as: it must never reach the console, otherwise it could
# upload a looser configuration or start another session.
AGENT_USER="${ETIK_AGENT_USER:-node}"

DOMAINS=("${BASE_DOMAINS[@]}")
HOST_PORTS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --domain)
            [[ "${2:-}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "ERROR: invalid domain '${2:-}'" >&2; exit 2; }
            DOMAINS+=("$2"); shift 2 ;;
        --host-port)
            [[ "${2:-}" =~ ^[0-9]+$ ]] && [ "$2" -ge 1 ] && [ "$2" -le 65535 ] || { echo "ERROR: invalid port '${2:-}'" >&2; exit 2; }
            HOST_PORTS+=("$2"); shift 2 ;;
        *)
            echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
    esac
done

echo "== Applying egress allowlist =="

# ---------------------------------------------------------------------------
# 0. Reset
# ---------------------------------------------------------------------------
# Only the filter table: the nat table holds the rules of Docker's embedded DNS
# (127.0.0.11) on the Compose network, which must survive.
iptables -F
iptables -X
ipset destroy allowed-domains 2>/dev/null || true

# ---------------------------------------------------------------------------
# 1. Allow the essentials BEFORE switching the default policy to DROP
# ---------------------------------------------------------------------------
# The agent user must not reach the ETiK console, whatever the interface: this
# rule comes before the loopback ACCEPT.
iptables -A OUTPUT -m owner --uid-owner "$AGENT_USER" -p tcp --dport "$ETIK_PORT" -j REJECT --reject-with tcp-reset

# Loopback
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# The ETiK console, reached from the host browser through the published port.
iptables -A INPUT -p tcp --dport "$ETIK_PORT" -j ACCEPT

# DNS (needed to resolve the allowlist below and at runtime)
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -j ACCEPT

# ---------------------------------------------------------------------------
# 2. Build the allowed-domains ipset
# ---------------------------------------------------------------------------
ipset create allowed-domains hash:net

for domain in "${DOMAINS[@]}"; do
    # dig prints its errors on stdout: keep only the addresses.
    ips=$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
    if [ -z "$ips" ]; then
        echo "  WARNING: failed to resolve $domain (skipping)"
        continue
    fi
    while read -r ip; do
        ipset add allowed-domains "$ip" 2>/dev/null || true
    done < <(echo "$ips")
    echo "  Added $domain"
done

# ---------------------------------------------------------------------------
# 3. Allow the Docker host gateway, only on HOST_PORTS
# ---------------------------------------------------------------------------
HOST_GATEWAY=$(getent hosts host.docker.internal | awk '{print $1}' | head -n1 || true)
if [ -n "${HOST_GATEWAY:-}" ]; then
    for port in "${HOST_PORTS[@]}"; do
        echo "Allowing host gateway $HOST_GATEWAY (host.docker.internal) on port $port"
        iptables -A OUTPUT -d "$HOST_GATEWAY" -p tcp --dport "$port" -j ACCEPT
    done
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

# Sanity check (warning only, to avoid failing on CDN timing).
# Any HTTP response means the connection went through; we don't need a 2xx, so
# no -f here (an unauthenticated GET to api.anthropic.com won't return 2xx).
if curl --connect-timeout 5 -sS -o /dev/null https://api.anthropic.com 2>/dev/null; then
    echo "OK: allowlisted egress works (api.anthropic.com reachable)."
else
    echo "WARNING: api.anthropic.com not reachable — allowlist may need refreshing."
fi

echo "== Egress allowlist applied =="
