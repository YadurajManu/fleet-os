#!/bin/bash
set -e
launchctl bootout gui/$(id -u)/dev.fleet-os.agent || true
cp '/Users/sujeetkumarsingh/Library/Application Support/fleet-os/bin/fleet-agent.pre-0.3.0-20260920' '/Users/sujeetkumarsingh/Library/Application Support/fleet-os/bin/fleet-agent'
rm -f '/Users/sujeetkumarsingh/Library/Application Support/fleet-os/config.json'
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/dev.fleet-os.agent.plist"
