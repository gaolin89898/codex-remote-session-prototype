# Codex Remote Session

A Codex desktop plugin for reading and continuing conversations on computers you configure. Connect directly over SSH or through a self-hosted relay. No server, account, token, or local computer is configured by default.

The plugin adds an independent **远程电脑** sidebar entry, native plugin settings, and seven conversation tools through MCP. The sidebar hands SSH connections and remote projects to Codex's native connection system.

## Install from the Git marketplace

Requires Node.js 22+ on `PATH` and a Codex version with plugin marketplace support. Tested with Codex CLI 0.164.0.

```powershell
codex plugin marketplace add gaolin89898/codex-remote-session-prototype --ref main
codex plugin add codex-remote-session@codex-remote-session-lab
```

If HTTPS is unavailable and GitHub SSH authentication is configured, use:

```powershell
codex plugin marketplace add git@github.com:gaolin89898/codex-remote-session-prototype.git --ref main
codex plugin add codex-remote-session@codex-remote-session-lab
```

You can also add `https://github.com/gaolin89898/codex-remote-session-prototype.git` as a Git marketplace in Codex. The committed package at `plugins/codex-remote-session` includes its dependencies; installation does not require cloning the source or running `npm install`.

This is a community Git marketplace, not an official OpenAI directory listing.

## Remote computers

Open **远程电脑** in the Codex sidebar. The compact list discovers concrete aliases in your local `~/.ssh/config`, including `Include` files, and shows configured remote computers. Wildcard aliases and the local computer are excluded. Use **+** to add a connection, or expand a computer to set its SSH alias and optional absolute remote project directory.

Connecting opens Codex's native SSH connection settings and enables that alias. With a project directory, Codex connects, requests remote folder access when needed, and opens the native remote project. Existing native connections are reused by alias; the plugin does not invent a native host ID or replace the native conversation menu. Install and authenticate Codex on the target computer and make SSH access available first.

Relay devices can be bound to an SSH alias reachable from this desktop, including through a VPN or SSH jump host. Relay connectivity alone cannot provide Codex's native SSH transport. **中继在线** refers only to relay discovery; after dispatch, connection progress and authentication are handled by Codex. Saved bindings remain available when relay discovery fails.

Aliases and project preferences are saved in `remote-session/native-connections.json` inside your Codex home. The plugin does not edit SSH configuration, Codex state files, or relay credentials directly; Codex handles native connection registration. The deep link was verified against the route parser in Codex desktop build `26.1021.3705.0`; a real remote project connection still requires a reachable, authenticated target.

## Plugin settings

Open this plugin's settings in Codex to configure the connection. The native settings form includes:

- Connection mode: disconnected, direct SSH, relay, or an external configuration file.
- Device name: defaults to this computer's hostname and supports custom names, including Chinese.
- SSH aliases or `user@host` targets, separated by commas, and a conversation-write toggle.
- Relay URL, a write-only controller token, and the viewing computer's optional agent ID.
- An advanced configuration file path, a connection test, and a clear-settings action.

Changes are saved under `remote-session/settings.json` in your Codex home, outside the installed plugin. They take effect without restarting the plugin. Blank token input preserves the saved token; clearing settings removes it and disconnects the old connection. Connection tests do not send prompts or start model inference. Settings remain available when the relay is offline.

The connection-test button opens a compact result dialog with progress, success or failure, elapsed time, and a retry action. A reachable relay with no online computers is reported separately. Relay checks verify a fresh response; authentication failures, wrong endpoint paths, and timeouts have visible diagnostics. Save settings before testing.

The computer agent uses the device name saved by the plugin. Changes are broadcast to connected viewers without disconnecting the agent or changing its ID. When no custom name is saved, the agent uses its configuration's `name`, or the computer's hostname. Updating the name does not start a computer agent; run the agent on each computer you want to make available. Relays must run version 0.4.2 or newer to broadcast name changes.

The plugin advertises the `openai/settings` extension for the host to render the form; it does not launch a separate conversation page or web server. This requires a Codex desktop version supporting native plugin settings. Settings tools are restricted to the app UI and do not return saved tokens.

## Configure a computer

For file-based configuration, create `remote-session/hosts.json` inside your Codex home directory (`~/.codex` by default, or `CODEX_HOME` when set):

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

Select the configuration-file connection mode and enter that file's absolute path in plugin settings. Existing `hosts.json` or `relay.json` files are discovered automatically until settings are first saved. `remote_hosts` returns an empty list until you configure a computer. Nothing reads this repository's `.local` files automatically.

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

Enter the generated controller URL and token in the viewing computer's plugin settings, or securely copy `.local/relay-controller.json` to a private file and select it in configuration-file mode. Set `viewerId` to that viewing computer's agent ID, or omit it if the viewer has no agent. A matching agent is hidden from its own discovery results. Each additional agent needs its own identity and token registered in the relay configuration. Never commit tokens.

The controller file contains `url`, `token`, and optional `viewerId` and `nativeHosts`. Use `wss://` for direct network connections, or `ws://127.0.0.1` through an encrypted tunnel. The relay enforces identity, read-only policy, request timeouts, and connection limits. It does not need a Codex login.

## Develop and verify

```powershell
npm ci
npm run build
npm test
npm run check:plugin
```

`npm run check:ui` checks both the connection-test dialog and the remote-computer view in a simulated MCP App host with desktop and narrow viewports, light and dark themes, loading, discovery, binding, native dispatch, validation, errors, and retry. It uses Microsoft Edge on Windows; set `PLAYWRIGHT_CHANNEL` to another installed Chromium channel when needed. Screenshots are written under ignored `.local/connection-ui` and `.local/computers-ui`. This does not automate the Codex desktop UI or confirm a real remote connection.

`build` regenerates the committed portable plugin and the ignored `dist` output. It does not read deployment configuration or embed machine paths. Commit the generated plugin whenever its source changes.

`check:plugin` installs into a temporary, empty Codex home and uses Codex app-server discovery to verify the installed server, native settings, and the global sidebar entry. It verifies seven conversation tools, six app-only tools, two UI resources, and no configured conversation hosts. Conversation tools have no UI entrypoints. The check runs outside the plugin directory so incorrect relative paths fail. It removes the temporary installation afterward. To check the published Git marketplace:

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
