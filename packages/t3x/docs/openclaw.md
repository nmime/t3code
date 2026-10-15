# Driving T3 from OpenClaw

Two directions exist, and they are not the same thing:

| direction         | how                                                                               | state                                                 |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **T3 → OpenClaw** | the worker runs `openclaw agent exec` as the coding agent inside a task's sandbox | built, verified (`provider: openclaw` in the profile) |
| **OpenClaw → T3** | OpenClaw connects to `t3x mcp` as an MCP server and gets T3's tasks as tools      | built, verified on the deployment                     |

This document is about the second one.

## What `t3x mcp` is

`t3x mcp` serves the control plane as an **MCP server on stdio**. It is an HTTP
client of the same API the Mac app, the phone app and the CLI use: same bearer
token, same `/tasks`, `/sandboxes`, `/profiles`. It never opens the control
plane's SQLite, so it can run anywhere that can reach the control plane — on the
VPS next to it, or on the machine where OpenClaw lives.

```
t3x mcp [--url http://127.0.0.1:8087] [--token TOKEN] [--profile default]
```

`T3X_API_URL`, `T3X_API_TOKEN` and `T3X_PROFILE` are the environment
equivalents, which is how an MCP client's own `env` block hands them over
without putting a credential on a command line.

## Install it into OpenClaw

`openclaw mcp add` probes a server before it saves it, so a wrong URL or a wrong
token fails here instead of in the middle of a conversation:

```bash
sudo -u openclaw openclaw mcp add t3 \
  --command node \
  --arg /opt/t3code/packages/t3x/dist/src/cli.js \
  --arg mcp \
  --env T3X_API_URL=http://127.0.0.1:8087 \
  --env T3X_API_TOKEN="$T3X_API_TOKEN" \
  --env T3X_PROFILE=default
```

Then check what OpenClaw sees:

```bash
openclaw mcp list          # the server is saved
openclaw mcp probe         # connect and list its capabilities
openclaw mcp tools t3      # the tool names it exposes
```

`openclaw mcp reload` disposes cached MCP runtimes so a changed config is used
on the next turn. Removing it again is `openclaw mcp unset t3`.

### From another machine

Point the bridge at the deployment instead of at loopback — the control plane is
publicly reachable behind nginx and needs the same bearer token:

```bash
openclaw mcp add t3 \
  --command node \
  --arg /path/to/t3code/packages/t3x/dist/src/cli.js \
  --arg mcp \
  --arg --url --arg https://t3code.n0xeid.xyz \
  --env T3X_API_TOKEN="$T3X_API_TOKEN"
```

## The tools

| tool                                                         | what it does                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `t3_status`                                                  | is the control plane reachable, how many tasks, which profiles               |
| `t3_profiles_list`                                           | the environment profiles a task can be created with                          |
| `t3_run`                                                     | **create a task, send a prompt, wait for the answer** — the one to reach for |
| `t3_task_create`                                             | create a task without a prompt (provision its sandbox, keep it idle)         |
| `t3_task_message`                                            | a follow-up message in the same task, same sandbox, same agent session       |
| `t3_task_wait`                                               | wait for the latest turn of a task to end, return its reply                  |
| `t3_task_get`                                                | one task's state, sandbox, worker, approvals, checkpoints                    |
| `t3_task_list`                                               | recent tasks                                                                 |
| `t3_task_events`                                             | the task's event stream, assistant chunks merged into a reply                |
| `t3_task_exec`                                               | run a shell command inside the task's sandbox                                |
| `t3_task_files`                                              | list a directory inside the sandbox                                          |
| `t3_task_git`                                                | git status or diff of what the agent changed                                 |
| `t3_task_stop` / `t3_task_resume` / `t3_task_destroy`        | sandbox lifecycle for one task                                               |
| `t3_sandbox_list` / `t3_sandbox_stop` / `t3_sandbox_destroy` | the sandboxes themselves                                                     |

A task is a sandbox with an agent in it: `t3_run` provisions it, the agent works
in `/workspace/project` (its own git worktree when the sandbox is shared), and
the reply comes back as text. Waiting is bounded by `waitSeconds` (default 900)
and ends early when the task needs a human: a task in state `waiting` has an
approval pending, and the tool says so instead of blocking.

## Try it

One turn on the OpenClaw host, with the tools in context:

```bash
openclaw agent exec \
  --config ~/.openclaw/openclaw.json \
  --model omniroute/auto/best-chat \
  --prompt 'Use the t3 MCP tools: run a T3 task that writes "hello from openclaw" into
            /workspace/project/openclaw-call.txt, then read the file back with t3_task_exec
            and report the task id.'
```

`openclaw agent exec` is a one-shot headless turn, so it is also how you test the
bridge without touching the Gateway or any channel.

## What this gives an agent, and what it does not

- It can start work that outlives the conversation: the task and its sandbox keep
  running after the OpenClaw turn ends, and `t3_task_wait` picks the answer up
  later.
- It can read the result directly (`t3_task_exec`, `t3_task_git`), which is what
  makes the answer trustworthy instead of a claim.
- It **cannot** reach a sandbox any other way: sandboxes are not published, and
  every operation goes through the control plane, which is also where the
  approval and checkpoint rules live.

The token is the control plane's admin credential: whoever holds it can create
tasks, run commands in sandboxes and destroy them. Give it to an OpenClaw
instance you trust, and mint a different one (the control plane takes one
`--api-token`, so this means a second deployment or a proxy) if two agents must
not share authority.

## The other direction, for contrast

T3 runs OpenClaw _inside_ a sandbox as a coding agent: the profile's `agents.allowed`
lists `openclaw`, and the worker's command template is
`openclaw agent exec --config $CWD/.openclaw/openclaw.json5 --model omniroute/auto/best-coding $PROMPT`
with `OPENCLAW_STATE_DIR` under the task's config home. That OpenClaw is a
one-shot process in a container — no Gateway, no channels, no skills — and it is
completely separate from the OpenClaw on the host that drives T3 through this
bridge. Neither knows about the other.
