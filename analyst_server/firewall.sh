#!/bin/bash
# Egress allowlist of the analyst container (adapted from ../test_environment/init-firewall.sh).
#
# The analyses' agent reads untrusted text (issues, merge requests, code): default-deny all outbound traffic,
# and only allow GitLab, the Anthropic API and, on the Docker host, the memory server's port.
#
# Usage: firewall.sh            apply the whole allowlist (at container start)
#        firewall.sh --refresh  re-resolve the allowed domains only (their CDN addresses rotate)
#
# Environment: GITLAB_URL, MEMORY_URL, PORT (the analyst's own port), FIREWALL_EXTRA_DOMAINS (space-separated).
# Requires: root, the NET_ADMIN + NET_RAW capabilities, iptables, ipset, dig, curl.

set -euo pipefail
IFS=$'\n\t'

host_of() { echo "$1" | sed -E 's#^[a-zA-Z]+://([^:/]+).*#\1#'; }
port_of() {
    local port
    port=$(echo "$1" | sed -nE 's#^[a-zA-Z]+://[^:/]+:([0-9]+).*#\1#p')
    if [ -n "$port" ]; then echo "$port"; elif [[ "$1" == https://* ]]; then echo 443; else echo 80; fi
}

GITLAB_HOST=$(host_of "${GITLAB_URL:-https://gitlab.com}")
MEMORY_URL="${MEMORY_URL:-http://host.docker.internal:9501}"
PORT="${PORT:-9502}"
read -r -a EXTRA <<< "$(echo "${FIREWALL_EXTRA_DOMAINS:-}" | tr ' ' '\t')" || true
DOMAINS=(api.anthropic.com "$GITLAB_HOST" "${EXTRA[@]}")

# Builds the set of allowed addresses under the given name.
fill_set() {
    ipset create "$1" hash:net -exist
    ipset flush "$1"
    for domain in "${DOMAINS[@]}"; do
        [ -n "$domain" ] || continue
        ips=$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)
        if [ -z "$ips" ]; then
            echo "  WARNING: failed to resolve $domain (skipping)"
            continue
        fi
        while read -r ip; do ipset add "$1" "$ip" -exist; done < <(echo "$ips")
        echo "  Allowed $domain"
    done
}

if [ "${1:-}" = "--refresh" ]; then
    # Swap in a fresh set, so that allowed connections never drop.
    fill_set allowed-domains-new
    ipset swap allowed-domains-new allowed-domains
    ipset destroy allowed-domains-new
    exit 0
fi

echo "== Applying egress allowlist =="
iptables -F
iptables -X
ipset destroy allowed-domains 2>/dev/null || true

iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
# The analyst's port, published to the host (the tester and you reach it there).
iptables -A INPUT -p tcp --dport "$PORT" -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

fill_set allowed-domains
iptables -A OUTPUT -p tcp --dport 443 -m set --match-set allowed-domains dst -j ACCEPT

# The memory server, when it is on the Docker host: only its port.
if [ "$(host_of "$MEMORY_URL")" = "host.docker.internal" ]; then
    gateway=$(getent hosts host.docker.internal | awk '{print $1}' | head -n1 || true)
    if [ -n "$gateway" ]; then
        echo "Allowing the memory server at $gateway (host.docker.internal) on port $(port_of "$MEMORY_URL")"
        iptables -A OUTPUT -d "$gateway" -p tcp --dport "$(port_of "$MEMORY_URL")" -j ACCEPT
    else
        echo "WARNING: could not resolve host.docker.internal: the memory server is not reachable."
    fi
fi

iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
# No IPv6 at all.
ip6tables -P INPUT DROP 2>/dev/null || true
ip6tables -P FORWARD DROP 2>/dev/null || true
ip6tables -P OUTPUT DROP 2>/dev/null || true
ip6tables -A INPUT -i lo -j ACCEPT 2>/dev/null || true
ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true

if curl --connect-timeout 5 -fsS https://example.com >/dev/null 2>&1; then
    echo "ERROR: verification failed — example.com is reachable but should be blocked."
    exit 1
fi
echo "OK: off-allowlist egress is blocked (example.com unreachable)."
if curl --connect-timeout 5 -sS -o /dev/null "https://$GITLAB_HOST" 2>/dev/null; then
    echo "OK: $GITLAB_HOST reachable."
else
    echo "WARNING: $GITLAB_HOST not reachable."
fi
echo "== Egress allowlist applied =="
