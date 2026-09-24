# Standalone bot — deploy notes

Minimal, self-contained. No dependency on `trained-assist-agent`. Runs on the
same shared VM (`136.65.7.197`) under the existing `vova` user — no separate
Linux user, per the "просто юзать общую инфру" decision.

## One-time VM setup

```bash
cd ~
git clone https://github.com/trained-assist/trained-assist-freelance-skill.git

mkdir -p ~/freelance-bot-data
chmod 700 ~/freelance-bot-data
# Bot token goes here, NEVER in git:
printf '%s' '<token from @BotFather>' > ~/freelance-bot-data/bot-token
chmod 600 ~/freelance-bot-data/bot-token

sudo cp ~/trained-assist-freelance-skill/bin/freelance-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freelance-bot
sudo journalctl -u freelance-bot -f
```

## Updating

```bash
cd ~/trained-assist-freelance-skill && git pull
sudo systemctl restart freelance-bot
```

## Agent backend

Runs on `opencode` + DeepSeek (`opencode-go/deepseek-v4.1-flash` by default,
override with `FREELANCE_BOT_MODEL`) instead of Claude Code — much cheaper for
this bot's volume. Uses the VM's existing `opencode-go` auth
(`~/.local/share/opencode/auth.json`, already set up for other tools on this
VM) and writes a project-local `opencode.json` per chat workspace declaring
only this repo's own MCP server — it does **not** touch the machine-wide
`~/.config/opencode/opencode.json`, which other concurrent sessions/repos on
this VM also read from.

## Telegram commands

Registered at bot startup via `setMyCommands` (shows in the "/" menu). Every
command is handled as a **quick answer** — the bot calls the skill's own MCP
tools directly (`runMcpTool`, a fresh `src/mcp-skills/index.js` child per call),
no opencode spawn, zero LLM tokens. Plain (non-command) messages still go to
the agent as before.

| Command | Maps to | Notes |
|---------|---------|-------|
| `/start` | — | welcome text |
| `/help` | — | command list + examples |
| `/projects` | `freelance_list` | |
| `/project <slug>` | `freelance_get_project` | full context dump |
| `/new Название: описание` | `freelance_new_project` | type=`default` |
| `/add <slug> <стадия> <текст>` | `freelance_add_info` | стадии: fact/requirement/interpretation/solution/qna |
| `/risk <slug>` | `freelance_assess` | |
| `/questions <slug>` | `freelance_questions` | |
| `/classify <текст>` | `freelance_classify_document` | needs OpenRouter key |
| `/folder <id>` | `freelance_set_folder` | |
| `/spec <slug>` | `freelance_generate_spec` | returns requirements+solution for ТЗ |

Slash commands are intentionally **never** forwarded into the agent CLI — a
leading `/` gets misparsed as the CLI's own command (see bot.js `/start`
comment). Unknown `/cmd` → `/help` text, not agent.

## Data layout

```
~/freelance-bot-data/
  bot-token              # mode 600, never committed
  bot-state.json         # Telegram getUpdates offset
  agent-tokens/<chat-id>/openrouter   # optional, for freelance_classify_document
  agent-tokens/<chat-id>/gdrive       # optional, for Google Sheets export
  users/chat-<chat-id>/
    .mcp.json            # points ONLY at this repo's own MCP server
    intake/              # downloaded Telegram attachments
    Фриланс проекты/     # the actual multi-project store — see top-level README
```

One Telegram chat = one profile (`chat-<chatId>`), no multi-chat-per-profile
mapping yet — deliberately simple for this first pass. Messages from the same
chat are queued and processed one at a time (two concurrent `claude` processes
writing into the same project files is a real corruption risk, not just a
nicety, since everything here is plain JSON/markdown on disk).

## Known limitations (v1, on purpose)

- No streaming — the bot waits for `claude --print` to fully finish, then sends
  one (possibly chunked) message. No "⏳ still working..." progress updates.
- No session/history continuity across messages beyond what's in
  `Фриланс проекты/<project>/` itself — each message is a fresh
  `claude --print` invocation with no conversation memory. Use
  `freelance_get_project` to recover context instead of relying on chat memory.
- Single Telegram bot process, no horizontal scaling, no retry queue beyond
  systemd's `Restart=on-failure`.
