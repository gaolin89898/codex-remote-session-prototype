---
name: remote-session
description: Read or continue Codex conversations on a configured local or SSH computer. Use when the user explicitly wants to inspect, message, or stop a conversation on another host.
---

Use the `codex_remote` MCP tools. Call `remote_hosts` to discover configured hosts; select the host by its returned ID. A host's credentials and project files remain on that host.

An empty host list is expected before setup. Direct users to the plugin's native settings to configure their SSH computers or relay and test the connection. Settings are saved in `remote-session/settings.json` inside `CODEX_HOME` (default `~/.codex`) and apply without a restart. Advanced users can select an external hosts or relay configuration file. No server is supplied or configured by the plugin. Never add a machine or send a message without the user's request.

Find the requested conversation with `remote_threads`, then read it with `remote_read`. Return only the history needed for the user's task. Follow pagination cursors rather than assuming the first page contains every conversation.

Send a message to an existing conversation only when the user asks to message or continue that conversation. Use `remote_prompt`, then `remote_status` and `remote_read` to collect progress and the result. Starting a turn is not evidence that the task completed. `remote_interrupt` stops a specific turn.

`allowWrite` in the host configuration controls conversation mutations. The prototype denies remote permission requests; report any resulting block instead of implying that it approved an action. A running conversation must be continued through its owning client; this prototype rejects a busy thread and does not steer active turns.

The native settings tools are app-only; never call them from the model or ask the user to paste relay tokens into chat. This plugin does not replace the desktop sidebar, switch the desktop client's transport, synchronize installed plugins, or provide a public relay.
