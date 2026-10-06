#!/bin/zsh
set -euo pipefail

repair_dir="${0:A:h}"
override_dir="$HOME/.opencli/clis"
backup_dir="$HOME/.opencli/pi-web-repair-backups/$(date +%Y%m%d-%H%M%S)-$$"

cd "$repair_dir"
shasum -a 256 -c SHA256SUMS.txt

for site in chatgpt deepseek; do
  mkdir -p "$override_dir/$site"
  for file in ask.js utils.js; do
    if [[ -e "$override_dir/$site/$file" ]]; then
      mkdir -p "$backup_dir/$site"
      cp -p "$override_dir/$site/$file" "$backup_dir/$site/$file"
    fi
    cp -p "$repair_dir/clis/$site/$file" "$override_dir/$site/$file"
  done
done

print "Web adapters installed. Existing overrides were backed up under: $backup_dir"
print "Keep OpenCLIApp running, then restart Pi Agent Desktop."
