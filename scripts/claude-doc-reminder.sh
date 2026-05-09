#!/usr/bin/env bash
# Claude Code SessionStart hook — checks whether the previous session left
# source code modified without corresponding doc updates, and reminds the
# assistant to consider doc/memory maintenance as part of the upcoming session.
#
# Outputs a system context line on stdout when applicable; silent otherwise.
# Never fails the session start (always exit 0).

set -e

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root"

# All uncommitted/untracked changes (porcelain so it's stable to parse)
changed=$(git status --porcelain 2>/dev/null) || exit 0
[ -z "$changed" ] && exit 0

# Did anything in source dirs change?
src_changed=$(echo "$changed" | awk '{print $2}' | grep -E "^(backend/|mobile/)" \
  | grep -v -E "^(mobile/docs/|backend/docs/)" || true)

# Or root-level dependency/config files?
cfg_changed=$(echo "$changed" | awk '{print $2}' | grep -E "^(package\.json|pnpm-lock\.yaml|go\.mod|go\.sum|docker-compose\.yml|lefthook\.yml|app\.config\.js)$" || true)

if [ -z "$src_changed" ] && [ -z "$cfg_changed" ]; then
  exit 0
fi

# Did docs/memory/CLAUDE.md change?
doc_changed=$(echo "$changed" | awk '{print $2}' | grep -E "^(CLAUDE\.md|mobile/docs/|backend/docs/|DATA_MODEL\.md)" || true)

if [ -n "$doc_changed" ]; then
  exit 0
fi

# Source changed without doc updates — emit a reminder.
cat <<'EOF'
[doc-freshness check] Source files in backend/ or mobile/ are modified but no updates to CLAUDE.md, mobile/docs/, backend/docs/, or DATA_MODEL.md are pending. Before doing more work this session, briefly review whether the prior session introduced anything that should be documented (new dependency, new pattern, new convention, new gotcha, new env var, schema change). If yes, update the appropriate doc per CLAUDE.md's routing rules. If no, proceed.
EOF
exit 0
