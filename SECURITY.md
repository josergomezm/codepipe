# Security Policy

## Trust model

CodePipe is a tool that runs **real AI CLI agents on your machine** and exposes
a chat interface to drive them. Understand this before deploying it:

- **It executes code.** The wrapped CLIs (Kiro, Claude Code, Antigravity) can read
  and write files, run shell commands, and call network/MCP tools in the
  selected project directory. CodePipe spawns those CLIs with the same
  privileges as the user running the server.
- **There is no built-in authentication.** The trust boundary is the machine or
  tailnet, not CodePipe itself. Anyone who can reach the server can drive the
  agents with full host privileges.
- **Bind to localhost.** The server defaults to `127.0.0.1`. Do not bind it to a
  public interface. For remote access, use [Tailscale](./README.md#remote-access-with-tailscale),
  which keeps it on your private tailnet — nothing is exposed to the internet.

### Project terminal

The **Terminal** tab opens a real shell in the project folder with the same
privileges as the server user — it's a direct remote shell, not a sandbox.
This doesn't widen the trust boundary (anyone who can reach CodePipe can
already have an agent run commands), but it makes it immediate, so the
localhost/tailnet guidance above matters even more. Shells keep running until
you exit or kill them, or the server stops.

### Tool auto-approval

Because there is no interactive terminal to approve tool calls, each adapter
auto-approves them so the agent can actually work. This is intentional but
means the agent acts without per-action confirmation:

- **Kiro (text transport):** launched with `--trust-all-tools` by default.
  The Providers page can turn that off and list the only tools to trust
  (`--trust-tools`); everything else is then denied, since non-interactive
  mode can't prompt.
- **Kiro (ACP):** the client auto-approves `request_permission` prompts.
- **Antigravity:** launched with `--dangerously-skip-permissions` by default;
  headless mode can't prompt, and without it shell commands are silently
  denied. The Providers page can turn it off, or add `--sandbox`.
- **Claude Code:** defaults to `--permission-mode acceptEdits`. This does **not**
  auto-approve arbitrary Bash or network access. Fuller autonomy (another
  permission mode, `--dangerously-skip-permissions`, allowed tools) is set on
  the Providers page — or via the `CLAUDE_PERMISSION_MODE` / `CLAUDE_EXTRA_ARGS`
  fallbacks — only on a machine and project you trust, since it removes
  Claude Code's safety prompts entirely.

These defaults live on the **Providers** page and can be overridden per
project (project settings) and per persona (team roster); the most specific
layer wins, and settings that broaden access are flagged in the UI. Because
the API accepts any value the CLI accepts, anyone who can reach CodePipe's
server can grant an agent full autonomy on your machine — keep it on your
tailnet.

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
