#!/usr/bin/env bash
# t3x end-to-end smoke test, run INSIDE a sandbox.
#
# The control plane and the worker both run in this sandbox, so the worker dials
# 127.0.0.1: this is the sandbox the smoke test owns, and dialing a control
# plane on another host would need this host to be reachable from inside it.
# Everything else is real: a real
# sandbox, real git, real worktrees, a real worker child process, the real
# WebSocket transport and real HTTP clients.
#
# Run it with scripts/sandbox-smoke/run.mjs, which creates the sandbox, uploads
# this file with the built package and the profiles, and deletes the sandbox
# again. Expects: $SMOKE_DIR/{smoke.sh,profile.yaml,profile-capped.yaml} and
# $HOME/t3x (the built package).
set -u
HOME_DIR="${T3X_SMOKE_HOME:-$HOME}"
SMOKE_DIR="${T3X_SMOKE_DIR:-$HOME_DIR/t3x-smoke}"
BUNDLE="$HOME_DIR/t3x"
STATE="$BUNDLE/state"
CP=http://127.0.0.1:8099
ORIGIN="$HOME_DIR/origin.git"
PROJECT="$HOME_DIR/project"
PASS=0; FAIL=0

say()  { printf '\n=== %s\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 (got '$2', want '$3')"; fi; }
contains(){ case "$2" in *"$3"*) ok "$1";; *) bad "$1 (no '$3' in: $(printf '%s' "$2" | head -c 260))";; esac; }
json(){ node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(eval('v.'+process.argv[1])??'')}catch(e){console.log('')}})" "$1"; }
# The local backend maps a sandbox-absolute path into its own directory tree.
map(){ echo "$STATE/sandboxes/$1/$2"; }

say "0. layout: bundle, dependencies, origin repository"
cd "$BUNDLE"
node --version
npm install --omit=dev --no-audit --no-fund --loglevel=error >/tmp/npm.log 2>&1 && ok "npm install (ws, yaml, zod)" || bad "npm install: $(tail -3 /tmp/npm.log)"

mkdir -p "$HOME_DIR/origin-src" && cd "$HOME_DIR/origin-src"
git init -q -b main . && echo "hello from the origin repo" > README.md && git add -A \
  && git -c user.name=t3x -c user.email=t3x@local commit -qm "initial commit" \
  && git clone -q --bare . "$ORIGIN" && ok "origin repo at $ORIGIN" || bad "origin repo"

say "1. control plane starts inside the sandbox"
cd "$BUNDLE"
nohup node dist/src/cli.js serve --state-dir "$STATE" --port 8099 >/tmp/cp.log 2>&1 &
for i in $(seq 1 40); do curl -sf "$CP/health" >/dev/null 2>&1 && break; sleep 0.5; done
contains "health endpoint answers" "$(curl -s "$CP/health")" "ok"
contains "backend is the local directory backend" "$(cat /tmp/cp.log)" "backend:      local"
node dist/src/cli.js profile add --state-dir "$STATE" --id smoke --file "$SMOKE_DIR/profile.yaml" >/dev/null && ok "profile smoke added"
node dist/src/cli.js profile add --state-dir "$STATE" --id capped --file "$SMOKE_DIR/profile-capped.yaml" >/dev/null && ok "profile capped added"

say "2. task create provisions a sandbox, checkout and worktree"
TASK=$(curl -s -X POST "$CP/tasks" -H 'content-type: application/json' \
  -d "{\"profileId\":\"smoke\",\"repositoryUrl\":\"file://$ORIGIN\",\"branch\":\"main\",\"provider\":\"echo\"}" | json "task.taskId")
echo "  task: $TASK"
for i in $(seq 1 60); do
  STATE_NOW=$(curl -s "$CP/tasks/$TASK" | json "task.state"); [ "$STATE_NOW" = "ready" ] && break; sleep 0.5
done
check "task reaches ready with the worker attached" "$STATE_NOW" "ready"
STATUS=$(curl -s "$CP/tasks/$TASK")
SBX=$(printf '%s' "$STATUS" | json "task.sandboxId")
WT=$(printf '%s' "$STATUS" | json "task.worktreePath")
BRANCH=$(printf '%s' "$STATUS" | json "task.worktreeBranch")
EVENTS=$(curl -s "$CP/tasks/$TASK/events")
contains "task.sandbox_created is in the log" "$EVENTS" "task.sandbox_created"
contains "task.worktree_created is in the log" "$EVENTS" "task.worktree_created"
contains "worker.attached is in the log" "$EVENTS" "worker.attached"
echo "  sandbox: $SBX  worktree: $WT ($BRANCH)"
check "the checkout was cloned" "$(head -1 "$(map $SBX $PROJECT)/README.md" 2>/dev/null)" "hello from the origin repo"
check "the task's worktree holds the checkout" "$(head -1 "$(map $SBX $WT)/README.md" 2>/dev/null)" "hello from the origin repo"
check "the worktree is on its own branch" "$(git -C "$(map $SBX $WT)" rev-parse --abbrev-ref HEAD 2>/dev/null)" "$BRANCH"
check "the worker process is running in the sandbox" "$(ps aux | grep -c 'worker/inde[x].js')" "1"

say "3. a turn runs through the real worker and provider runtime"
curl -s -X POST "$CP/tasks/$TASK/messages" -H 'content-type: application/json' -d '{"text":"say hello","runtimeMode":"auto"}' >/dev/null
for i in $(seq 1 60); do
  EVENTS=$(curl -s "$CP/tasks/$TASK/events")
  case "$EVENTS" in *turn.terminal*) break;; esac
  sleep 0.5
done
contains "the turn reached a terminal state" "$EVENTS" "turn.terminal"
contains "the worker reported the thread" "$EVENTS" "thread.updated"
contains "the assistant answered (echo runtime)" "$EVENTS" "echo"
contains "the mode the turn ran under is recorded" "$EVENTS" "auto"

say "4. runtime mode: a profile cap refuses a stronger turn"
CAPTASK=$(curl -s -X POST "$CP/tasks" -H 'content-type: application/json' \
  -d "{\"profileId\":\"capped\",\"repositoryUrl\":\"file://$ORIGIN\",\"branch\":\"main\",\"provider\":\"echo\",\"scope\":\"task\"}" | json "task.taskId")
for i in $(seq 1 60); do
  S=$(curl -s "$CP/tasks/$CAPTASK" | json "task.state"); [ "$S" = "ready" ] && break; sleep 0.5
done
REFUSAL=$(curl -s -o /tmp/refusal.json -w '%{http_code}' -X POST "$CP/tasks/$CAPTASK/messages" -H 'content-type: application/json' -d '{"text":"rm -rf /","runtimeMode":"full-access"}')
check "a turn stronger than the cap is refused" "$REFUSAL" "422"
contains "the refusal names the cap" "$(cat /tmp/refusal.json)" "permits runtime mode"
ALLOWED=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CP/tasks/$CAPTASK/messages" -H 'content-type: application/json' -d '{"text":"say hello","runtimeMode":"approval-required"}')
check "a turn at the cap is accepted" "$ALLOWED" "202"

say "5. fork: same sandbox, own worktree off the source's branch head"
FORKTHREAD="thread_smoke_fork_$RANDOM"
FORK=$(curl -s -X POST "$CP/tasks/$TASK/fork" -H 'content-type: application/json' -d "{\"threadId\":\"$FORKTHREAD\"}")
FORKID=$(printf '%s' "$FORK" | json "task.taskId")
for i in $(seq 1 60); do S=$(curl -s "$CP/tasks/$FORKID" | json "task.state"); [ "$S" = "ready" ] && break; sleep 0.5; done
FORKSTATUS=$(curl -s "$CP/tasks/$FORKID")
FORKEVENTS=$(curl -s "$CP/tasks/$FORKID/events")
contains "the fork records where it came from" "$FORKEVENTS" "forkedFromTaskId"
contains "the fork records the source thread" "$FORKEVENTS" "forkedFromThreadId"
check "the fork shares the source's sandbox" "$(printf '%s' "$FORKSTATUS" | json "task.sandboxId")" "$SBX"
FORKWT=$(printf '%s' "$FORKSTATUS" | json "task.worktreePath")
if [ "$FORKWT" != "$WT" ]; then ok "the fork has its own worktree"; else bad "the fork reused the source's worktree"; fi
contains "the fork's worktree holds the checkout" "$(ls "$(map $SBX $FORKWT)" 2>/dev/null | head -3)" "README.md"
DUP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CP/tasks/$TASK/fork" -H 'content-type: application/json' -d "{\"threadId\":\"$FORKTHREAD\"}")
check "a claimed thread is refused with a conflict" "$DUP" "409"

say "6. text generation: one prompt, no thread, nothing in the log"
GEN=$(curl -s -X POST "$CP/text-generation" -H 'content-type: application/json' -d "{\"cwd\":\"$WT\",\"prompt\":\"summarise the repository\"}")
contains "generation answered" "$GEN" "text"
BEFORE=$(curl -s "$CP/tasks/$TASK/events")
curl -s -X POST "$CP/text-generation" -H 'content-type: application/json' -d "{\"cwd\":\"$WT\",\"prompt\":\"again\"}" >/dev/null
AFTER=$(curl -s "$CP/tasks/$TASK/events")
if [ "$AFTER" = "$BEFORE" ]; then ok "generation is not a turn: the task log is unchanged"; else bad "generation wrote to the task log"; fi
MISSING=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CP/text-generation" -H 'content-type: application/json' -d '{"cwd":"/nope","prompt":"x"}')
check "generation for an unknown cwd is refused" "$MISSING" "404"

say "7. scope and refcounted lifecycle"
SECOND=$(curl -s -X POST "$CP/tasks" -H 'content-type: application/json' \
  -d "{\"profileId\":\"smoke\",\"repositoryUrl\":\"file://$ORIGIN\",\"branch\":\"main\",\"provider\":\"echo\"}" | json "task.taskId")
for i in $(seq 1 60); do S=$(curl -s "$CP/tasks/$SECOND" | json "task.state"); [ "$S" = "ready" ] && break; sleep 0.5; done
check "a second task of the project shares the sandbox" "$(curl -s "$CP/tasks/$SECOND" | json "task.sandboxId")" "$SBX"
BOUND=$(curl -s "$CP/sandboxes" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d).sandboxes.find(x=>x.sandboxId===process.argv[1]);console.log(s?s.taskCount:'?')})" "$SBX")
if [ "$BOUND" -ge 3 ]; then ok "the sandbox is reference counted ($BOUND tasks bound)"; else bad "refcount is $BOUND"; fi
STOPCODE=$(curl -s -o /tmp/stop.json -w '%{http_code}' -X POST "$CP/sandboxes/$SBX/stop")
check "stopping a sandbox with tasks bound is refused" "$STOPCODE" "409"
contains "the refusal says why" "$(cat /tmp/stop.json)" "stop_refused"
contains "and the sandbox is listed" "$(node dist/src/cli.js sandbox list --state-dir "$STATE")" "$SBX"
DEDICATED=$(curl -s -X POST "$CP/tasks" -H 'content-type: application/json' \
  -d "{\"profileId\":\"smoke\",\"repositoryUrl\":\"file://$ORIGIN\",\"branch\":\"main\",\"provider\":\"echo\",\"scope\":\"task\"}" | json "task.taskId")
for i in $(seq 1 60); do S=$(curl -s "$CP/tasks/$DEDICATED" | json "task.state"); [ "$S" = "ready" ] && break; sleep 0.5; done
DEDBOX=$(curl -s "$CP/tasks/$DEDICATED" | json "task.sandboxId")
if [ "$DEDBOX" != "$SBX" ]; then ok "the per-task toggle produced its own sandbox"; else bad "the toggle reused the shared sandbox"; fi
curl -s -X POST "$CP/tasks/$DEDICATED/stop" >/dev/null; sleep 1
for i in $(seq 1 20); do S=$(curl -s "$CP/tasks/$DEDICATED" | json "task.state"); [ "$S" = "suspended" ] && break; sleep 0.5; done
check "a dedicated sandbox is stoppable once its task lets go" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CP/sandboxes/$DEDBOX/stop")" "202"

say "8. git state is bound to the right worktree"
printf 'a change made in the task worktree\n' > "$(map $SBX $WT)/change.txt"
contains "git status sees the task's own change" "$(curl -s "$CP/tasks/$TASK/git/status")" "change.txt"
if [ -f "$(map $SBX $PROJECT)/change.txt" ]; then bad "the base checkout saw the task's file"; else ok "the base checkout is untouched"; fi
contains "the sibling task does not see it" "$(curl -s "$CP/tasks/$SECOND/git/status")" "clean"

say "9. the worker's own view: thread, worktrees and checkpoints"
GIT=$(curl -s "$CP/tasks/$TASK/git/status")
contains "the task knows its branch" "$GIT" "$BRANCH"
CPOINT=$(curl -s -X POST "$CP/tasks/$TASK/checkpoints" -H 'content-type: application/json' -d '{"label":"smoke"}')
check "a checkpoint can be taken" "$CPOINT" '{"ok":true}'
contains "the checkpoint is listed for the task" "$(curl -s "$CP/tasks/$TASK/checkpoints")" "checkpoint"

say "RESULT"
printf '  passed: %s   failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ] || { echo "--- control plane log tail ---"; tail -30 /tmp/cp.log; }
exit $FAIL
