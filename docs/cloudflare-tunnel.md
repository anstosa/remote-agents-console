# Existing Cloudflare Tunnel

Create or keep existing HTTPS hostnames for the console and configured project previews. Route both the console and project hostnames to `http://127.0.0.1:8787`, and preserve each browser-facing Host header. The console proxies configured project hosts to their fixed loopback ports and injects the navigation bridge used by its browser toolbar. Set `publicOrigin` to the console's exact `https://host` origin. Do **not** configure the application with Cloudflare credentials and do not expose a public listener.

Example existing tunnel ingress (illustrative only):

```yaml
ingress:
  - hostname: my-project.example.com
    service: http://127.0.0.1:8787
    originRequest:
      httpHostHeader: my-project.example.com
  - hostname: agents.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

The application does not call the Cloudflare API. Its secure `__Host-rac` cookie requires HTTPS at the browser-facing origin.

## Continuous route checks and recovery

RAC continuously checks the configured tunnel's public route independently of
whether Settings is open, checking every 15 seconds without overlapping probes.
It compares a fresh challenge response from the local
server with the public HTTPS response, so a running connector alone is not
treated as proof that the tunnel is delivering requests.

Two consecutive public-route failures while the local server is healthy produce a
**Tunnel degraded** notification throughout the console. A local-server failure
or unavailable monitoring is not reported as a confirmed Cloudflare connection
bug. The notification clears after the public route is verified again.
Temporary loss of installation capability preserves an existing warning but
disables Reconnect. Explicitly removing tunnel management disables monitoring.

The active controller can select **Reconnect** to restart only the installed
Cloudflare connector. RAC first paints a full-screen **Reconnecting tunnel**
page, then sends the restart request. The page stays visible until the public
route is verified again or reconnection fails; it does not embed the notification
toast. This does not restart RAC, change its public address,
replace credentials, or apply unrelated pending Settings changes. RAC never
automatically restarts the tunnel. Reconnection can briefly interrupt console
and project-preview connections sharing that tunnel.

The public `/healthz` route must remain accessible without a Cloudflare Access
login or browser challenge. If the public path is completely unreachable, the
browser cannot deliver a Reconnect request through that path; use an already
available alternative administrative connection to recover the connector.
