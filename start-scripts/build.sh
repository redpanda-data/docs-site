#!/bin/bash

# Get the latest Redpanda Console version
export CONSOLE_VERSION=$(node start-scripts/getLatestConsoleVersion.js);

# Set the latest-console-version attribute
if [[ -n "$CONSOLE_VERSION" ]]; then
  attribute="--attribute latest-console-version=$CONSOLE_VERSION"
else
  attribute=""
fi

# Build the site
antora --to-dir docs $attribute --fetch antora-playbook.yml
