# Agent-native recording MCP server

`rec-mcp` is a local stdio MCP server. It gives an MCP-capable coding agent four
structured tools instead of requiring it to parse the `rec` CLI's terminal output.
It never exposes the recorder beyond the local machine.

| Tool | Purpose |
| --- | --- |
| `recording_start` | Starts a recording. It reuses an attached browser, or launches local Chrome and attaches before recording when none is available. |
| `recording_marker` | Adds a labelled checkpoint to the active recording. |
| `recording_status` | Returns recorder state, elapsed time, and browser attachment information. |
| `recording_stop` | Stops the recording and returns its ID, bundle details, and local replay URL. |

`recording_start` accepts an optional title, origin allowlist, canvas option, and
Chrome executable. Its default origin is the active browser page. The recorder's
existing password masking remains enabled; broader masking policy is intentionally
deferred to a later phase.

## Standalone setup

Build the repository, then configure any MCP client to launch the server over
stdio. Substitute this checkout's absolute path:

```json
{
  "mcpServers": {
    "rec": {
      "command": "node",
      "args": ["/absolute/path/to/rec/packages/mcp/dist/main.js"]
    }
  }
}
```

Set `REC_DAEMON_URL` only when the daemon is intentionally running somewhere
other than `http://127.0.0.1:7717`. The MCP server starts the daemon on demand.

## Codex plugin

The local `rec-mcp` Codex plugin is a thin wrapper around that same command. Its
MCP configuration points at this checkout's built `packages/mcp/dist/main.js`.
It is deliberately local-only: installation adds no hosted service, credentials,
or sharing capability.
