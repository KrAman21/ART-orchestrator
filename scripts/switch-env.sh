#!/bin/bash

# Environment Switcher for ART Orchestrator
# Usage: ./scripts/switch-env.sh [local|sbx]

ENV_FILE=".env"
TARGET_ENV=$1

if [ -z "$TARGET_ENV" ]; then
  CURRENT_ENV=$(grep "^NODE_ENV=" "$ENV_FILE" | cut -d'=' -f2)
  echo "Current environment: $CURRENT_ENV"
  echo "Usage: $0 [local|sbx]"
  exit 0
fi

if [ "$TARGET_ENV" != "local" ] && [ "$TARGET_ENV" != "sbx" ]; then
  echo "Error: Invalid environment. Use 'local' or 'sbx'"
  exit 1
fi

sed -i "s/^NODE_ENV=.*/NODE_ENV=$TARGET_ENV/" "$ENV_FILE"

if [ "$TARGET_ENV" == "local" ]; then
  LSP_URL=$(grep "^LSP_URL_LOCAL=" "$ENV_FILE" | cut -d'=' -f2)
  GW_URL=$(grep "^GW_URL_LOCAL=" "$ENV_FILE" | cut -d'=' -f2)
else
  LSP_URL=$(grep "^LSP_URL_SBX=" "$ENV_FILE" | cut -d'=' -f2)
  GW_URL=$(grep "^GW_URL_SBX=" "$ENV_FILE" | cut -d'=' -f2)
fi

echo "✅ Environment switched to: $TARGET_ENV"
echo ""
echo "Configuration:"
echo "  NODE_ENV: $TARGET_ENV"
echo "  LSP_URL:  $LSP_URL"
echo "  GW_URL:   $GW_URL"
echo ""
echo "Run 'npm start' to start ART Orchestrator in $TARGET_ENV environment"
