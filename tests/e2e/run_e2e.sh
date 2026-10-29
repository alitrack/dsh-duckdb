# e2e against the real dsh headless runtime.
#
# This needs a configured provider (a real DeepSeek API key or equivalent),
# so it is NOT part of CI. The key-free harness (`keyless.mjs`) covers the
# plugin contract and every guard; this run covers the remaining layer: that
# dsh's loader actually mounts the plugin, advertises the tools to a model,
# and the model can drive them end to end.
#
# Usage:
#   export DEEPSEEK_API_KEY=sk-...
#   bash tests/e2e/run_e2e.sh

set -eu

PLUGIN="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/headless}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"

echo "plugin:  $PLUGIN"
echo "profile: $PROFILE"
echo "dsh:     $DSH_VERSION"

cd "$PROFILE"

npx --yes "@deepseek-ai/dsh@${DSH_VERSION}" --profile headless \
  --patch "$PLUGIN/tests/e2e/local-overlay.yml" \
  "$(cat "$PLUGIN/tests/e2e/task.txt")"
