# Whiplash

**English** · [한국어](README.ko.md)

Conduct your AI agents from a chat room, and drive them hard from the console.

Whiplash takes over Claude Code and Codex sessions **wherever they started** and puts them in Slack-style channels. Bring in sessions from a terminal, from Orca or from any other tool, call them with `@name`, and let agents hand work to each other.

## Run

You need Node 24 or later and the `claude` or `codex` CLI. The live terminal uses `node-pty` and `xterm.js`, so install dependencies first.

```bash
npm install   # or pnpm install
npm start
```

Open `http://127.0.0.1:4717`. Data lives in `~/.whiplash`; set `WHIPLASH_HOME` to move it and `PORT` to change the port.

## Use

1. **Create a channel** with a name and a project folder.
2. **Import a session** to add a recent Claude Code or Codex session as a member, or **hire a new agent** that works in its own git worktree.
3. **Conduct**: call members with `@name`. `@all` runs every member at once.

| Feature | What it does |
| --- | --- |
| The Stage | The channel conversation. Click a member to open their Studio. |
| The Studio | The agent's live terminal, changed files, diffs, and branch and worktree state. Click an agent in the left rail to open it. |
| Not quite my tempo | Reject a result with the button or `/tempo @name reason`. |
| Stamina bar | Drains as the agent's context fills up. |
| Throw the chair | An alert when a turn fails or the channel's check command (for example `pnpm build`) fails. |
| Chain limit | Agents stop after passing work back and forth 6 times and wait for the conductor. |
| Reply | Click an agent's message, and messages without `@` go to that session. |
| Plan limits | Claude and Codex 5-hour and weekly usage with reset times, at the bottom of the left rail. |
| Languages | English and Korean. The browser language is the default; switch with the button at the bottom left. |
| Themes | Light and dark, following the system until you pick one. The terminal uses your Orca font and terminal themes. |

## How it works

- **Discovery** reads `~/.claude/projects` and `~/.codex/sessions`. Nothing needs to be installed or hooked.
- **Takeover** runs each turn with `claude -p --resume` or `codex exec resume`. The session id stays the same, so you can reopen it in its original console.
- **Isolation** runs every turn inside each CLI's OS sandbox, so writes outside the agent's folders are refused. An imported session may also write to the channel's project folder. Reads are not blocked.
- **Collision guard** refuses to send to a session another console just wrote, because continuing one session from two places splits the conversation.
- **Plan limits** are read the way Orca reads them: the Claude login from the macOS keychain (or `~/.claude/.credentials.json`) and the Codex login from `~/.codex/auth.json`. The tokens are only sent to each provider's own usage endpoint.
- **Live terminal** runs the session's own CLI in a PTY. While it is open, Stage messages are typed into it and the reply is read from the session transcript; when it is closed, turns run headless.

## Good to know

- A session that is open in a terminal can be continued in Whiplash about a minute after you close it there.
- Headless turns refuse commands that need approval, because they have no prompt to ask. Open the terminal to approve them yourself.
- The live terminal runs with your own CLI permission settings, not the headless sandbox.
- If the terminal is showing a dialog, a Stage message cannot get in; Whiplash says so after 20 seconds.
- Restarting the server clears Studio logs and stops running turns. Channels and conversations are kept.
- The server listens only on `127.0.0.1` and refuses requests from other origins. Do not expose it.

## Develop

```bash
npm test
pnpm install && pnpm typecheck
```

The design borrows Buzz's mention rules and agent chain limit, and Orca's worktree-first flow. Code under `src/orca` and `public/orca` is adapted from Orca (MIT) and runs Orca's own tests; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No Buzz code is included.
