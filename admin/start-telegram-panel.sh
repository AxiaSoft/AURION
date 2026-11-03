#!/usr/bin/env bash
# Superseded by the merged admin panel: Telegram is a tab in it now,
# alongside Updates and Licences. Kept so an old habit still works.
echo
echo "  The Telegram panel is now a tab in the AURION admin panel."
echo "  Starting that instead..."
echo
exec "$(dirname "$0")/start-panel.sh"
