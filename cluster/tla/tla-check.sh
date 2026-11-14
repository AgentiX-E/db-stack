#!/bin/bash
# tla-check.sh — Download tla2tools.jar and run TLC model checker on JointConsensus
# Usage: bash tla/tla-check.sh [model_path]
# Will auto-download tla2tools.jar if not present.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODEL="${1:-$SCRIPT_DIR/JointConsensus.tla}"
MODEL_NAME="$(basename "$MODEL" .tla)"
TLA_JAR="$SCRIPT_DIR/tla2tools.jar"

# ── Download tla2tools.jar if missing ──
if [ ! -f "$TLA_JAR" ]; then
  echo "⏳ Downloading tla2tools.jar..."
  
  # Try multiple sources
  for URL in \
    "https://github.com/tlaplus/tla2tools/releases/download/v1.6.1/tla2tools.jar" \
    "https://github.com/tlaplus/tla2tools/releases/download/1.6.1/tla2tools.jar" \
    "https://tla.msr-inria.inria.fr/tlatoolbox/update-site/tla2tools.jar" \
    "https://nightly.tlaplus.org/tla2tools.jar"; do
    if curl -sLf --connect-timeout 10 -o "$TLA_JAR" "$URL" 2>/dev/null; then
      JAR_SIZE=$(stat -c%s "$TLA_JAR" 2>/dev/null || stat -f%z "$TLA_JAR" 2>/dev/null)
      if [ "${JAR_SIZE:-0}" -gt 100000 ]; then
        echo "✅ Downloaded from: $URL ($(numfmt --to=iec $JAR_SIZE))"
        break
      fi
    fi
    rm -f "$TLA_JAR"
  done

  if [ ! -f "$TLA_JAR" ]; then
    echo "ERROR: Could not download tla2tools.jar. Run manually:"
    echo "  wget -O $TLA_JAR https://github.com/tlaplus/tla2tools/releases/download/v1.6.1/tla2tools.jar"
    echo "Or place the jar at: $TLA_JAR"
    exit 1
  fi
fi

# ── Find config ──
CFG="${MODEL%.tla}MC.cfg"
if [ ! -f "$CFG" ]; then
  echo "WARN: No config file found at $CFG, running without it."
  CFG=""
fi

# ── Run TLC ──
echo "🚀 Running TLC model checker on $MODEL_NAME..."
echo "   Config: ${CFG:-none}"
echo ""

WORKDIR="$SCRIPT_DIR"
cd "$WORKDIR"

if [ -n "$CFG" ]; then
  java -cp "$TLA_JAR" tlc2.TLC -modelcheck -config "$CFG" "$MODEL" 2>&1
else
  java -cp "$TLA_JAR" tlc2.TLC -modelcheck "$MODEL" 2>&1
fi

# ── Parse result ──
EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ TLC completed — all invariants checked."
  echo "   States generated (approx): check output above."
else
  echo ""
  echo "❌ TLC failed with exit code $EXIT_CODE"
  echo "   Check the error trace above for invariant violation."
fi

exit $EXIT_CODE
