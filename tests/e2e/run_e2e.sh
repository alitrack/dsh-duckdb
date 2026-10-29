# e2e against the real dsh headless runtime.
#
# Needs no API key: this points the agent at a LOCAL OpenAI-compatible model
# (the same endpoint sigil's benchmark uses) via the llm-pi-ai adapter. The
# version-compatibility exemption lives in the profile's compatibility.json,
# NOT in a CLI command — see the note below.
#
# Usage: bash tests/e2e/run_e2e.sh

set -eu

PLUGIN="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/headless}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"
# Local models still need this variable to exist; the value is arbitrary.
export LOCAL_QWEN_API_KEY="${LOCAL_QWEN_API_KEY:-local}"

COMPAT="$PROFILE/compatibility.json"
PLUGIN_VERSION="$(node -p "require('$PLUGIN/package.json').version")"
KEY="dsh-duckdb@${PLUGIN_VERSION}"

# The error message tells you to run `dsh plugin allow-version`, which is NOT
# a real command — it falls through to pnpm and fails. The actual mechanism is
# a profile-local compatibility.json mapping exact name@version to exact dsh
# versions (see dsh-app-boot/lib/index.js:341).
if ! grep -q "\"$KEY\"" "$COMPAT" 2>/dev/null; then
  echo "granting version exemption: $KEY on dsh $DSH_VERSION"
  printf '{ "%s": ["%s"] }\n' "$KEY" "$DSH_VERSION" > "$COMPAT"
fi

echo "plugin:  $PLUGIN (v$PLUGIN_VERSION)"
echo "profile: $PROFILE"
echo "dsh:     $DSH_VERSION"

# dsh derives the session workspace from the process cwd. Running from the
# profile directory would make the fixture files "outside the workspace" and
# every call would fail ESCAPE — a real guard result, but the wrong test.
# cd into the fixture directory so the paths in task.txt are inside it.
cd "$PLUGIN/tests/e2e/ws"

npx --yes "@deepseek-ai/dsh@${DSH_VERSION}" --profile headless \
  --patch "$PLUGIN/tests/e2e/local-overlay.yml" \
  --patch "$PLUGIN/tests/e2e/local-model-overlay.yml" \
  "$(cat "$PLUGIN/tests/e2e/task.txt")"
