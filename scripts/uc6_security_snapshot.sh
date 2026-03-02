#!/usr/bin/env bash
set -euo pipefail

redact_stream() {
  sed -E \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/g' \
    -e 's/((UC6_|NEXT_PUBLIC_UC6_)(ADMIN_TOKEN|BOT_ADMIN_TOKEN|PRIVATE_KEY)[[:space:]]*[:=][[:space:]]*)[^[:space:]]+/\1[REDACTED]/g' \
    -e 's#(https?://[^/[:space:]]+/v3/)[A-Za-z0-9]+#\1[REDACTED]#g' \
    -e 's/((authorization|token|secret|privateKey|adminToken)["'\'']?[[:space:]]*[:=][[:space:]]*["'\'']?)[^"'\''[:space:],}]+/\1[REDACTED]/g'
}

print_section() {
  printf '\n== %s ==\n' "$1"
}

print_section "OS"
uname -a
if command -v lsb_release >/dev/null 2>&1; then
  lsb_release -a 2>/dev/null || true
else
  cat /etc/os-release 2>/dev/null || true
fi

print_section "Users"
getent passwd | awk -F: '{print $1 ":" $3 ":" $4 ":" $7}'

print_section "Groups"
getent group | awk -F: '{print $1 ":" $3}'

print_section "UC6 User"
id uc6 2>/dev/null || echo "user uc6 not present"

print_section "Open Ports"
ss -lntup 2>/dev/null || ss -lntu 2>/dev/null || true

print_section "Systemd Unit Summary"
systemctl status uc6-lp-bot.service --no-pager -l 2>/dev/null | redact_stream || true
printf '\n'
systemctl show uc6-lp-bot.service \
  -p User \
  -p Group \
  -p ExecStart \
  -p NoNewPrivileges \
  -p PrivateTmp \
  -p PrivateDevices \
  -p ProtectSystem \
  -p ProtectHome \
  -p ProtectControlGroups \
  -p ProtectKernelModules \
  -p ProtectKernelTunables \
  -p LockPersonality \
  -p RestrictAddressFamilies \
  -p RestrictNamespaces \
  -p RestrictRealtime \
  -p MemoryMax \
  -p CPUQuota \
  2>/dev/null | redact_stream || true

print_section "Systemd Unit File"
systemctl cat uc6-lp-bot.service 2>/dev/null | redact_stream || true

print_section "UC6 File Permissions"
ls -ld /opt/uc6-bot 2>/dev/null || true
ls -l /opt/uc6-bot 2>/dev/null || true
stat -c '%n %U:%G %a' /opt/uc6-bot/.env 2>/dev/null || echo "/opt/uc6-bot/.env missing"
stat -c '%n %U:%G %a' /opt/uc6-bot/settings.json 2>/dev/null || echo "/opt/uc6-bot/settings.json missing"
stat -c '%n %U:%G %a' /opt/uc6-bot/state.json 2>/dev/null || echo "/opt/uc6-bot/state.json missing"

print_section "Node and NPM"
node --version 2>/dev/null || true
npm --version 2>/dev/null || true

print_section "NPM Audit Summary"
if [[ -d /opt/uc6-bot/app ]]; then
  if audit_json="$(cd /opt/uc6-bot/app && npm audit --omit=dev --json 2>/dev/null)"; then
    AUDIT_JSON="$audit_json" node - <<'EOF'
const raw = process.env.AUDIT_JSON || "";
try {
  const parsed = JSON.parse(raw);
  const meta = parsed.metadata?.vulnerabilities || {};
  const deps = parsed.metadata?.dependencies || {};
  console.log(`dependencies total=${deps.total ?? "?"} prod=${deps.prod ?? "?"}`);
  console.log(
    `vulnerabilities critical=${meta.critical ?? 0} high=${meta.high ?? 0} moderate=${meta.moderate ?? 0} low=${meta.low ?? 0} info=${meta.info ?? 0}`
  );
} catch {
  console.log("npm audit output could not be parsed");
}
EOF
  else
    echo "npm audit unavailable or failed"
  fi
else
  echo "/opt/uc6-bot/app missing"
fi

print_section "Recent Journal (last 200 lines)"
journalctl -u uc6-lp-bot.service -n 200 --no-pager 2>/dev/null | redact_stream || true
