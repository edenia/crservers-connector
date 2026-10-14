#!/usr/bin/env bash
# Builds the portable package OpenAI's plugin submission expects (plugin.json, mcp.json, skills/, assets/).
# README.md stays out: reviewer credentials and notes go in the dashboard, never in the ZIP.
set -euo pipefail
cd "$(dirname "$0")"
grep -q 'REPLACE-WITH-DEMO-VIDEO-URL' plugin.json && { echo "Set review.demo_recording_url in plugin.json first." >&2; exit 1; }
out="${1:-crservers-ai-connect.zip}"
rm -f "$out"
zip -qr "$out" plugin.json mcp.json skills assets -x '.*'
echo "$out"
