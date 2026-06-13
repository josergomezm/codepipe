# Security Policy

## Trust model

CodePipe is a tool that runs **real AI CLI agents on your machine** and exposes
a chat interface to drive them. Understand this before deploying it:

- **It executes code.** The wrapped CLIs (Kiro, Claude Code, Gemini) can read
  and write files, run shell commands, and call network/MCP tools in the
  selected project directory. CodePipe spawns those CLIs with the same
  privileges as the user running the server.
- **There is no built-in authentication.** The trust boundary is the machine or
  tailnet, not CodePipe itself. Anyone who can reach the server can drive the
  agents with full host privileges.
- **Bind to localhost.** The server defaults to `127.0.0.1`. Do not bind it to a
  public interface. For remote access, use [Tailscale](./README.md#remote-access-with-tailscale),
  which keeps it on your private tailnet — nothing is exposed to the internet.

### Tool auto-approval

Because there is no interactive terminal to approve tool calls, each adapter
auto-approves them so the agent can actually work. This is intentional but
means the agent acts without per-action confirmation:

- **Kiro (text transport):** launched with `--trust-all-tools`.
- **Kiro / Gemini (ACP):** the client auto-approves `request_permission`
  prompts; Gemini is additionally switched to an auto-approve session mode.
- **Claude Code:** defaults to `--permission-mode acceptEdits`. This does **not**
  auto-approve arbitrary Bash or network access. To grant fuller autonomy set
  `CLAUDE_PERMISSION_MODE` or append `--dangerously-skip-permissions` via
  `CLAUDE_EXTRA_ARGS` — only do this on a machine and project you trust, since
  it removes Claude Code's safety prompts entirely.

Run CodePipe only against project directories whose contents you trust, and be
aware that a prompt-injection payload in a file the agent reads could cause it
to take actions. Prefer the narrowest permission setting that still lets your
workflow function.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Use GitHub's **"Report a vulnerability"** (Security → Advisories) on the
repository, or email the maintainers listed in the repo metadata. Include:

- a description of the issue and its impact,
- steps to reproduce,
- affected version/commit.

We aim to acknowledge reports within a few days. Please give us reasonable time
to ship a fix before any public disclosure.

## Scope

In scope: the CodePipe server, client, and adapter layer. Out of scope: the
behavior of the underlying CLI tools themselves (report those to their
respective vendors) and any deployment that ignores the localhost/tailnet
guidance above.
