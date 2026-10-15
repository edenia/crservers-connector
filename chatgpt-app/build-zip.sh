#!/usr/bin/env bash
# Builds the portable package OpenAI's plugin submission expects (plugin.json, mcp.json, skills/, assets/).
# README.md stays out: reviewer credentials and notes go in the dashboard, never in the ZIP.
set -euo pipefail
cd "$(dirname "$0")"
# OpenAI accepts incomplete uploads; the demo video URL must be real before you click Submit.
grep -q 'REPLACE-WITH-DEMO-VIDEO-URL' plugin.json && echo "warning: review.demo_recording_url is still a placeholder; set it and re-upload before submitting." >&2
out="${1:-crservers-ai-connect.zip}"
rm -f "$out"
zip -qr "$out" plugin.json mcp.json skills assets -x '.*'
echo "$out"
