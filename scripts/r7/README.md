# r7 prod stack scripts

Reference copies of the `~/loomscope-{up,down,status}.sh` scripts the
author keeps on the r7 home server. They live here so the architecture
they encode (fanout container + prod on 5180 + dev on 5181) is
version-controlled alongside the code.

## What changed from the original (pre-fanout)

| | Before | After |
|---|---|---|
| prod listen port | 5174 (direct) | 5180 (behind fanout) |
| CC hook URL | `http://localhost:5174/api/cc-hook` | unchanged |
| 5174 hosted by | prod Loomscope (bare node) | **fanout container** (docker) |
| dev coexistence | impossible (port clash) | runs on 5181, fanout fans to both |

CC's `~/.claude/settings.json` does **not** change. The fanout container
takes 5174 transparently and forwards to whatever upstreams are up.

## Install on r7

```bash
# One-time
cp scripts/r7/loomscope-up.sh    ~/loomscope-up.sh
cp scripts/r7/loomscope-down.sh  ~/loomscope-down.sh
cp scripts/r7/loomscope-status.sh ~/loomscope-status.sh
chmod +x ~/loomscope-{up,down,status}.sh

# Sanity check (does NOT start anything yet)
~/loomscope-status.sh
```

## Daily use from Mac

```bash
# Bring stack up + open SSH tunnel to prod's 5180
ssh -t -L 5180:localhost:5180 r7 'bash ~/loomscope-up.sh'

# In a separate Mac shell — peek at status
ssh r7 'bash ~/loomscope-status.sh'

# Shut everything down
ssh r7 'bash ~/loomscope-down.sh'
```

Open <http://localhost:5180> on the Mac (tunneled to r7's prod
Loomscope). The fanout container on r7:5174 receives CC hooks and
fans them out to prod (5180) + dev (5181, if running).

## Migration from the old `~/loomscope-up.sh`

If you already have an older `~/loomscope-up.sh` that binds prod
directly to 5174:

```bash
# 1. Stop the old setup
~/loomscope-down.sh     # if the old script had one, otherwise:
pkill -f src/server/cli.ts

# 2. Replace the scripts
cp <repo>/scripts/r7/loomscope-*.sh ~/

# 3. Start the new stack
~/loomscope-up.sh
```

Verify with `~/loomscope-status.sh` — should show fanout :5174 and
prod :5180 both running.

## Env knobs

All three scripts honor these env vars (defaults in parens):

- `LOOMSCOPE_REPO_DIR` (~/Loomscope) — checkout location
- `LOOMSCOPE_PROD_PORT` (5180) — prod listen port
- `LOOMSCOPE_DEV_PORT` (5181) — dev listen port (status only)
- `LOOMSCOPE_LOG` (~/loomscope.log) — prod stdout/stderr

`LOOMSCOPE_SECRET` is read automatically from `~/.loomscope/secret`
and exported into the fanout container's env via docker-compose. If
that file is missing, `loomscope-up.sh` aborts with a clear error.
