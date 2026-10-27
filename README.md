# Codex Remote Session

A Codex desktop plugin for reading and continuing conversations on computers you configure. Connect directly over SSH or through a self-hosted relay. No server, account, token, or local computer is configured by default.

The plugin provides seven conversation tools through MCP. It has no separate page. Integration with the desktop's native conversation interface and computer selector remains unfinished.

## Install from the Git marketplace

Requires Node.js 22+ on `PATH` and a Codex version with plugin marketplace support. Tested with Codex CLI 0.164.0.

```powershell
codex plugin marketplace add gaolin89898/codex-remote-session-prototype --ref main
codex plugin add codex-remote-session@codex-remote-session-lab
```

You can also add `https://github.com/gaolin89898/codex-remote-session-prototype.git` as a Git marketplace in Codex. The committed package at `plugins/codex-remote-session` includes its dependencies; installation does not require cloning the source or running `npm install`.

This is a community Git marketplace, not an official OpenAI directory listing.

## Configure a computer

Create `remote-session/hosts.json` inside your Codex home directory (`~/.codex` by default, or `CODEX_HOME` when set):

```json
{
  "hosts": [
    {
      "id": "devbox",
      "name": "Development computer",
      "transport": "ssh",
      "target": "devbox",
      "allowWrite": false
    }
  ]
}
```

`target` is your own SSH alias or `user@host`. Configure SSH key authentication and install and authenticate Codex on that computer. Check `ssh devbox codex --version`; the bridge uses batch mode and cannot ask for a password. The local transport is opt-in; see `hosts.example.json`.

Restart the plugin connection after changing configuration. `remote_hosts` returns an empty list until you configure a computer. Nothing reads this repository's `.local` files automatically.

Set `allowWrite: true` to permit starting conversations, sending messages, and interrupting turns. Shell and file access still use the read-only sandbox. Interactive approvals are declined. Avoid controlling the same conversation from several clients; this prototype cannot guarantee ownership detection across independent app-server processes.

Environment overrides are available for custom launchers: `CODEX_REMOTE_HOSTS_FILE` selects a hosts file; `CODEX_REMOTE_RELAY_FILE` selects a relay controller file. Set only one.

## Optional relay

The relay forwards authenticated requests in memory. Conversations, project files, credentials for Codex, and execution remain on the computer agents. There is no hosted relay supplied with this project.

```text
Codex plugin ------> your relay <------ computer agent
                                             |
                                             +--> Codex app-server
```

Build from source, then deploy to your own Linux server with Node.js 22 at `/usr/bin/node`, systemd, and root access through an SSH alias:

```powershell
npm ci
npm run build
npm run deploy -- --target=my-relay
node dist/relay/agent.mjs --config=.local/relay-agent.json
```

Deployment generates separate random agent and controller tokens in ignored `.local` files. It installs `codex-session-relay.service` under `/opt/codex-session-relay`; the relay binds only to `127.0.0.1:3420`. The computer agent creates an SSH tunnel on local port 3425 and reconnects after disconnections.

On each viewing computer, establish its own SSH tunnel:

```powershell
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:3425:127.0.0.1:3420 my-relay
```

Copy the generated `.local/relay-controller.json` securely to `remote-session/relay.json` inside that viewing computer's Codex home. Set `viewerId` to that viewing computer's agent ID, or omit it if the viewer has no agent. A matching agent is hidden from its own discovery results. Keep either `hosts.json` or `relay.json` in the configuration directory. Each additional agent needs its own identity and token registered in the relay configuration. Never commit tokens.

The controller file contains `url`, `token`, and optional `viewerId` and `nativeHosts`. Use `wss://` for direct network connections, or `ws://127.0.0.1` through an encrypted tunnel. The relay enforces identity, read-only policy, request timeouts, and connection limits. It does not need a Codex login.

## Develop and verify

```powershell
npm ci
npm run build
npm test
npm run check:plugin
```

`build` regenerates the committed portable plugin and the ignored `dist` output. It does not read deployment configuration or embed machine paths. Commit the generated plugin whenever its source changes.

`check:plugin` installs into a temporary, empty Codex home and verifies seven backend tools, no HTML resource, and no configured hosts. It removes the temporary installation afterward. To check the published Git marketplace:

```powershell
npm run check:plugin -- --source=git@github.com:gaolin89898/codex-remote-session-prototype.git
```

Tests cover app-server RPC, pagination, read-only enforcement, busy-turn rejection, approval denial, relay authentication, routing, timeouts, reconnection, and configuration isolation. Optional `npm run probe -- --exercise` reads real local metadata and creates an ephemeral conversation without sending a prompt or starting model inference. `node scripts/relay-check.mjs --config=controller.json` verifies a relay with exactly one read-only agent on the same computer as the verifier.

Backend tools: `remote_hosts`, `remote_threads`, `remote_read`, `remote_start`, `remote_prompt`, `remote_status`, and `remote_interrupt`.

## Limitations and references

App-server is an experimental integration surface. This prototype has not been validated for production use, does not synchronize installed plugins, and does not replace Codex's native remote connection transport.

- [Plugin packaging](https://developers.openai.com/plugins/build/plugins/)
- [App-server protocol](https://developers.openai.com/codex/app-server/)
- [Native remote connections](https://developers.openai.com/codex/remote-connections/)
- [Open-source Codex components](https://developers.openai.com/codex/open-source/)
