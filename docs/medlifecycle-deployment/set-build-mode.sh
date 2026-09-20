#!/bin/bash
set -euo pipefail
mode=${1:?local or agent}
case "$mode" in local|agent) ;; *) exit 2;; esac
ssh -o BatchMode=yes fleet-cp python3 - "$mode" <<'PY'
import sys,pathlib,subprocess
p=pathlib.Path('/opt/fleet-os/deploy/.env')
lines=p.read_text().splitlines(); changes={'BUILD_MODE':sys.argv[1],'BUILD_REGISTRY_URL':'https://fleetbuilds.plastikworld.xyz','ALLOW_QEMU_FALLBACK':'false'}
lines=[line for line in lines if line.split('=',1)[0] not in changes]
p.write_text('\n'.join(lines+[k+'='+v for k,v in changes.items()])+'\n')
subprocess.run(['docker','compose','up','-d','--no-deps','--no-build','control-plane'],cwd='/opt/fleet-os/deploy',check=True)
PY
