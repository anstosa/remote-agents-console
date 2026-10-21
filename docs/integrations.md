# ChatGPT, MCP, and Realtime voice

Remote Agents exposes one typed orchestration gateway through two clients:

- a remote MCP endpoint at `https://your-public-origin.example/mcp` for ChatGPT
- a browser Realtime voice dialog opened from the purple **Davo** button in the server row

Both paths use the same tool catalog, feature flags, exact scopes, voice-mode
mutation gate, idempotency store, and redacted audit log. They do not expose the raw
terminal or an arbitrary shell. Integration prompts beginning with `!` are
rejected rather than entering the console's local shell mode.

## Configuration

Add the integration gates to the server JSON configuration:

```json
{
  "integrations": {
    "enabled": true,
    "mcp": {
      "readEnabled": true,
      "writeEnabled": true,
      "dangerousEnabled": false
    },
    "realtime": {
      "enabled": true,
      "name": "Davo",
      "context": "The caller is Ansel. Always speak with a masculine, broad Australian accent and a relaxed bogan tradie cadence.",
      "writeToolsEnabled": true
    }
  }
}
```

Every integration is disabled by default. Keep `dangerousEnabled` false until
the deployment's operational policies have been reviewed.

Provide writable private state paths to the server process:

```dotenv
RAC_INTEGRATION_AUTH_FILE=/workspace/.data/integration-auth.json
RAC_INTEGRATION_STATE_FILE=/workspace/.data/integration-state.json
RAC_INTEGRATION_AUDIT_FILE=/workspace/.data/integration-audit.jsonl
```

For voice, also set `RAC_OPENAI_API_KEY` in the ignored server environment.
The standard API key stays on the server. The browser receives only a
short-lived Realtime client secret.

Optional independent secrets:

```dotenv
RAC_REALTIME_MCP_TOKEN=<at-least-32-random-characters>
RAC_INTEGRATION_FEDERATION_SECRET=<base64url-encoded-32-byte-secret>
```

If omitted, these are derived from or fall back to the existing server secrets.
Use explicit, matching federation secrets on every server for multi-instance
tool forwarding.

## Connect ChatGPT

1. Deploy Remote Agents at its configured canonical HTTPS `publicOrigin`.
2. Add a ChatGPT custom app or connector whose MCP URL is
   `https://your-public-origin.example/mcp`.
3. Complete the Remote Agents OAuth consent page in the same browser where the
   console is signed in.
4. Grant only the scopes needed for that connection.

The server publishes OAuth protected-resource and authorization-server
metadata, supports dynamic public-client registration, requires authorization
code plus PKCE S256, binds tokens to the exact MCP audience, rotates refresh
tokens, and challenges unauthenticated MCP requests.

See OpenAI's current [MCP server guide](https://developers.openai.com/plugins/build/mcp-server)
and [custom app authentication guide](https://developers.openai.com/plugins/build/auth)
for the ChatGPT product-side setup and account availability.

## Use Davo

Enable **Davo** in Settings, then choose **Call Davo** and grant microphone
access. While enabled, Settings exposes the assistant's display name and a free-form
context field. The name defaults to `Davo`; the context defaults to the repository's
current Ansel-facing Australian bogan-tradie persona. Changing the context replaces
that persona without changing the fixed tool, safety, or call-control instructions.
The current server, worktree, and agent canonical identifiers are included as session
context. Realtime calls the same remote MCP endpoint; the browser does not implement
a second tool router. No separate MCP setup is required for voice.

Starting Davo activates remote mutations. A browser heartbeat retains that
access while Davo remains active. **Hang up** revokes access immediately without
cancelling agent work. Hiding the fullscreen call on mobile leaves the call
active. Losing browser control or disappearing without a clean close expires
access within 25 seconds.

## Scopes and gates

| Scope | Capability |
| --- | --- |
| `status:read` | instances, worktrees, agents, Git, PR, review, and stack state |
| `logs:read` | latest responses, bounded terminal output, prompt history, and stack logs |
| `files:read` | contained bounded file previews |
| `prompts:write` | queue, edit, move, remove, and answer prompts |
| `agents:control` | cancel, launch, deactivate, new-task, and PR-switch operations |
| `stack:operate` | configured stack actions only |
| `review:write` | reserved for typed review operations |
| `admin:dangerous` | additive scope for disruptive operations |

Scopes do not override deployment flags or the active browser voice-mode gate.
Mutation calls also require an idempotency request ID. Interrupted effects are
recorded as an unknown outcome and are not repeated automatically.

File previews reject hidden credential stores, deployment configuration, and
key or certificate material. Terminal, history, file, and stack output is also
redacted for credential-shaped values before it reaches an integration client.

## Multi-instance federation

Every tool accepts an optional `instance_id`. Omitting it targets the connected
server. A configured remote instance is reached through a signed, timestamped
federation request; the original OAuth bearer is never forwarded. Delegated
scopes and the originating active-voice authorization are rechecked by the
target gateway, which applies its own feature flags, idempotency, and audit
policy.

Federation is enabled automatically when an instance has at least one entry in
`remoteServers`, and disabled when its remote-server list is empty. There is no
separate multi-instance toggle; legacy `integrations.multiInstance.enabled` values
are accepted for compatibility but do not override this behavior.

Both instances still need integrations enabled, compatible integration code, and
matching federation secrets. Partial outages return an `instance_unavailable`
tool error without hiding the healthy instances.
