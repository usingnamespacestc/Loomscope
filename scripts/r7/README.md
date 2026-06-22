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

## Recommended r7 layout — two folders

The fanout architecture invites a two-folder split on r7 so prod's
source code is insulated from dev's branch-switching. Single folder
also works for casual use, but two folders is the cleaner pattern
once you're actively editing the codebase.

```
~/Loomscope         ← PROD checkout. Pinned to main. Only `git pull`
                      here. `~/loomscope-up.sh` reads from here by
                      default. The fanout container builds from this
                      folder's services/fanout/ (compose context).
~/Loomscope-dev     ← DEV checkout. Free to `git checkout <branch>`
                      or `git fetch <PR>`. Run `cd ~/Loomscope-dev &&
                      npm run dev` for the 5181 backend + 5175 vite.
~/.loomscope/       ← SHARED runtime state — secret, preferences,
                      disk cache. Single user, same identity for both
                      checkouts; no isolation needed.
```

### Why two folders

- **prod stays on stable code.** Tsx evaluates source at runtime,
  not ahead of time. If you `git checkout feature-x` in `~/Loomscope`
  while prod is running, the next request handler that re-imports a
  module reads the new code. Two folders lets `~/Loomscope-dev`
  swing branches freely without prod ever noticing.
- **dev's hot-reload doesn't fight prod's process.** `npm run dev`
  uses tsx watch — file changes restart the dev backend in place.
  In a single folder, every save would also tick the file-watcher
  hooks that prod's chokidar uses to invalidate caches. Two folders
  is two separate `cwd` trees, two independent watch graphs.
- **State stays shared on purpose.** `~/.loomscope/secret` is the
  same value either backend hands to CC for hook auth; `cache/` is
  atomic-write so dev rebuilding a session's cache and prod reading
  it can't corrupt either side (worst case: cache miss → rebuild
  from jsonl, ~hundreds of ms).

### Setup (assuming you already cloned to `~/Loomscope`)

```bash
# Make a second checkout for dev work
git clone git@github.com:usingnamespacestc/Loomscope.git ~/Loomscope-dev
cd ~/Loomscope-dev && npm install
# (Don't `npm run start` here — that would clash with prod on 5180.
#  `npm run dev` listens on 5181 by default.)
```

That's it — no env vars to set, no config to change. The defaults
already align:

- `~/loomscope-up.sh` defaults `LOOMSCOPE_REPO_DIR=~/Loomscope` → prod
- `npm run dev` defaults to port 5181 → dev
- `docker-compose.yml` in either folder builds the same fanout image;
  the convention is to run `docker compose up -d` from `~/Loomscope`
  (prod folder is the source of truth for the always-on container)

### When single folder is fine

If you don't actively develop Loomscope and just want the viewer
running on r7, one folder (`~/Loomscope`) is enough. You'd skip the
`~/Loomscope-dev` clone and never run `npm run dev`; only the prod
listener on 5180 and the fanout container on 5174 are up. The
two-folder split only pays off once you `git checkout` or rebuild
the dev backend regularly.

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

- `LOOMSCOPE_REPO_DIR` (~/Loomscope) — checkout location. Point at
  `~/Loomscope-dev` if you want the *script-driven* prod runner to
  source from the dev checkout instead (rare; usually you want prod
  on the stable `~/Loomscope` and start dev via `npm run dev` from
  `~/Loomscope-dev` directly, bypassing these scripts).
- `LOOMSCOPE_PROD_PORT` (5180) — prod listen port
- `LOOMSCOPE_DEV_PORT` (5181) — dev listen port (status only — the
  scripts don't manage dev's lifecycle; `npm run dev` handles that)
- `LOOMSCOPE_LOG` (~/loomscope.log) — prod stdout/stderr

`LOOMSCOPE_SECRET` is read automatically from `~/.loomscope/secret`
and exported into the fanout container's env via docker-compose. If
that file is missing, `loomscope-up.sh` aborts with a clear error.
