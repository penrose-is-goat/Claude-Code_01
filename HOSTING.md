# Sharing and Hosting the Side Tools

## Fastest Tester Link: Cloudflare Quick Tunnel

This keeps the current Python application unchanged and exposes it through a temporary HTTPS URL.

1. Start the application in one PowerShell window:

   ```powershell
   cd "C:\Users\thleg\OneDrive\Documents\New project\side-tools"
   python .\serve.py --no-open
   ```

2. In a second window, run the included launcher:

   ```powershell
   .\share-side-tools.bat
   ```

   You can also double-click `share-side-tools.bat`. The launcher calls the bundled portable `tools\cloudflared.exe` directly, verifies that Side Tools is responding, and therefore does not require `cloudflared` on PATH or `winget`.

3. Share the URL printed under `CURRENT SHAREABLE LINK`. The launcher verifies that the public URL reaches this app and records its status in `.cache/public-url.json`.

To check the last recorded link later, run:

```powershell
python .\share_side_tools.py --status
```

Both terminal windows and the computer must remain running. The URL changes whenever the Quick Tunnel restarts. Quick Tunnels are intended for demos and testing, not permanent production hosting.

## Stable Cloudflare Subdomain

For a reusable hostname such as `macro.example.com`:

1. In the Cloudflare dashboard, open **Networking > Tunnels** and create a remotely managed tunnel.
2. Install the connector using the Windows command Cloudflare provides.
3. Add a published application route for the desired hostname.
4. Set its service URL to `http://127.0.0.1:8017`.
5. Keep `python .\serve.py --no-open` and the Cloudflare connector running.

Cloudflare can create the DNS route automatically when the domain uses Cloudflare DNS. Add Cloudflare Access if testers should authenticate before reaching the application.

## Always-On Cheap Hosting: AWS Lightsail + Cloudflare

Use a small Ubuntu Lightsail instance when the application should remain available while the development computer is off.

Recommended initial size: 1 GB Linux instance. Upload the `side-tools` directory, then run:

```bash
python3 serve.py --host 0.0.0.0 --port 8017 --no-open
```

For an Internet-facing deployment, run the process under `systemd` and place it behind either a named Cloudflare Tunnel or an HTTPS reverse proxy. Do not expose the development server directly without access controls and rate limiting.

If a FRED API key is needed for broad series search, configure it as the server environment variable `FRED_API_KEY`; do not place it in client-side JavaScript or commit it to the project.

## Why Not Cloudflare Pages Yet?

The current application is a long-running Python HTTP server with filesystem caching. Cloudflare Pages can host the static HTML, CSS, and JavaScript immediately, but its dynamic Functions run on the Workers model. Moving the APIs there requires adapting the server handlers, cache, settings, and provider requests rather than uploading `serve.py` unchanged.

That migration may be worthwhile later, but a Tunnel is the quickest and least risky way to get real-user feedback first.

## Public Demo Warning

The application calls third-party data providers on behalf of visitors. A publicly shared, unauthenticated link can consume provider limits or be abused. Keep Quick Tunnel demos short-lived; for a stable hostname, add Cloudflare Access or another authentication/rate-limiting layer.
