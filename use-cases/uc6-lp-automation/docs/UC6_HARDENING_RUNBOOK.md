# UC6 Hardening Runbook

This runbook applies manual hardening on the UC6 VM without changing trading logic.

## Assumptions
- Debian or Ubuntu-like VM
- systemd service name: `uc6-lp-bot.service`
- UC6 files live under `/opt/uc6-bot`
- Bot user is `uc6`

## 1. Verify File Ownership And Permissions
### Apply
```bash
sudo chown -R uc6:uc6 /opt/uc6-bot
sudo chmod 700 /opt/uc6-bot
sudo chmod 700 /opt/uc6-bot/app
sudo chmod 600 /opt/uc6-bot/.env
sudo chmod 600 /opt/uc6-bot/settings.json
sudo chmod 600 /opt/uc6-bot/state.json
sudo chmod 600 /opt/uc6-bot/positions.json
```

### Verify
```bash
stat -c '%n %U:%G %a' /opt/uc6-bot /opt/uc6-bot/.env /opt/uc6-bot/settings.json /opt/uc6-bot/state.json
```

### Rollback
```bash
sudo chmod 755 /opt/uc6-bot /opt/uc6-bot/app
```

## 2. Apply Hardened systemd Unit
### Apply
```bash
cd ~/bank-poc
sudo install -o root -g root -m 644 scripts/uc6-lp-bot.service /etc/systemd/system/uc6-lp-bot.service
sudo systemctl daemon-reload
sudo systemctl restart uc6-lp-bot.service
```

### Verify
```bash
systemctl show uc6-lp-bot.service \
  -p User -p Group -p NoNewPrivileges -p PrivateTmp -p PrivateDevices \
  -p ProtectSystem -p ProtectHome -p ProtectControlGroups \
  -p ProtectKernelModules -p ProtectKernelTunables \
  -p LockPersonality -p RestrictAddressFamilies -p RestrictNamespaces -p RestrictRealtime
systemctl status uc6-lp-bot.service --no-pager -l
```

### Rollback
```bash
sudo cp /etc/systemd/system/uc6-lp-bot.service /etc/systemd/system/uc6-lp-bot.service.rollback.$(date +%s)
sudo editor /etc/systemd/system/uc6-lp-bot.service
sudo systemctl daemon-reload
sudo systemctl restart uc6-lp-bot.service
```

## 3. SSH Hardening
### Apply
Edit `/etc/ssh/sshd_config` and ensure:
```text
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM yes
```

Then reload SSH:
```bash
sudo sshd -t
sudo systemctl reload ssh || sudo systemctl reload sshd
```

### Verify
```bash
sudo sshd -T | egrep 'passwordauthentication|permitrootlogin|pubkeyauthentication|kbdinteractiveauthentication'
```

### Rollback
```bash
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.rollback.$(date +%s)
sudo editor /etc/ssh/sshd_config
sudo sshd -t
sudo systemctl reload ssh || sudo systemctl reload sshd
```

## 4. Firewall Hardening
### Recommended
Do not expose the bot directly to the internet if you can avoid it.

Preferred options:
- bind UC6 bot to `127.0.0.1` and place it behind Nginx plus Cloudflare Access
- bind UC6 bot to `127.0.0.1` and access via Tailscale or WireGuard

### Minimum UFW setup
Allow SSH and optionally HTTPS, deny everything else:
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

If you must expose the bot directly:
```bash
sudo ufw allow 8797/tcp
```

That is not the preferred posture.

### Verify
```bash
sudo ufw status numbered
ss -lntp | grep 8797 || true
```

### Rollback
```bash
sudo ufw status numbered
sudo ufw delete <rule-number>
```

## 5. Bind Bot To Loopback Only (Optional But Strongly Recommended)
### Apply
In `/opt/uc6-bot/.env`:
```text
UC6_HTTP_HOST=127.0.0.1
```

Restart:
```bash
sudo systemctl restart uc6-lp-bot.service
```

### Verify
```bash
ss -lntp | grep 8797
curl --max-time 3 -sS http://127.0.0.1:8797/health
```

### Rollback
Set:
```text
UC6_HTTP_HOST=0.0.0.0
```
and restart the service.

## 6. Journald Review And Snapshot
Run the included snapshot script:
```bash
cd ~/bank-poc
chmod +x scripts/uc6_security_snapshot.sh
sudo ./scripts/uc6_security_snapshot.sh
```

This prints:
- OS and kernel
- users and groups
- open ports
- systemd unit state
- `/opt/uc6-bot` file permissions
- Node/npm versions
- npm audit summary
- recent journal logs with secret-like strings redacted

## 7. Local Security Self-Test
Run from the repo:
```bash
chmod +x scripts/uc6_security_selftest.mjs
node scripts/uc6_security_selftest.mjs
```

This checks:
- challenge replay semantics
- signature validation
- expired-message rejection
- rate limiting behavior
- constant-time bearer helper presence
- body size limit declarations
- static assurance that bot `/status` is cache-only

## 8. Vercel Environment Hygiene
### Verify
- `UC6_BOT_ADMIN_TOKEN` must exist only as a server-side env var
- `UC6_OWNER_ADDRESS` may be public
- no bearer token or private key may appear in `NEXT_PUBLIC_*`

### Manual Review
Check Vercel project settings and confirm:
- owner token is server-only
- no production logs contain authorization headers

## 9. Incident Response Basics
If you suspect compromise:
1. Set `killSwitch=true`
2. Stop the bot:
```bash
sudo systemctl stop uc6-lp-bot.service
```
3. Rotate:
- Base wallet private key
- `UC6_ADMIN_TOKEN`
- RPC API keys
4. Archive:
- `/opt/uc6-bot/settings.json`
- `/opt/uc6-bot/state.json`
- `/opt/uc6-bot/positions.json`
- `/opt/uc6-bot/events.jsonl`
5. Run the snapshot script before making further changes
