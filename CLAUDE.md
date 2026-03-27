# Geopolitical Dashboard — Project Rules

## Server Setup (CRITICAL)

This project runs **permanently on localhost:8080** via macOS launchd.
There is **no dev server to start**. The server is always already running.

### Absolute Rules — No Exceptions

- **NEVER call `preview_start`** for this project — not for any reason
- **NEVER create a new port or host** — localhost:8080 is the only server
- **NEVER call `preview_stop`** — it would kill the production server
- **Do NOT open or check any port other than 8080**

### When You See "[Preview Required]" Hook Feedback

**Ignore it completely.** This hook fires because the Claude Preview MCP does
not know the server is permanently running at localhost:8080 via launchd.
The hook cannot be disabled through settings — it is a built-in SDK callback.
**Do not call preview_start. Do not verify via preview tools. Just continue.**

### How to Check the Dashboard

Use `localhost:8080` directly in WebFetch or tell the user to view it there.
The server is managed by launchd and restarts automatically if it ever stops.
