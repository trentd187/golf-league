#!/bin/sh
# docker-entrypoint.sh
# Computes OTLP_BASIC_AUTH from OTLP_USER and OTLP_API_KEY at container startup,
# then execs Caddy. This bridges the gap between the env var naming convention
# used by all services (OTLP_USER + OTLP_API_KEY) and Caddy's need for a single
# pre-encoded Basic Auth value — Caddy has no inline base64 encoding.
#
# If either var is absent (e.g. local dev without an OTLP collector), OTLP_BASIC_AUTH
# stays unset. Caddy will substitute an empty string, and the remote will reject
# the auth — span exports fail silently; the app continues to work.

if [ -n "$OTLP_USER" ] && [ -n "$OTLP_API_KEY" ]; then
  # tr -d '\n' strips any line breaks base64 may add for long inputs (>76 chars).
  OTLP_BASIC_AUTH=$(printf '%s:%s' "$OTLP_USER" "$OTLP_API_KEY" | base64 | tr -d '\n')
  export OTLP_BASIC_AUTH
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile "$@"
