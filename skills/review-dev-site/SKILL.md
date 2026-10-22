---
name: review-dev-site
description: Use only when the owner asks you to make a running web app available for his review, or says he wants to look at it from his phone. Do not use for ordinary local development, your own review, or testing; keep that loop on localhost with Playwright.
---

# Review a dev site

Make a running web app available to the owner only when he asks for a review or says he wants to look at it from his phone. Your own development, self-review, and testing stay on localhost with Playwright.

## Start the review

1. The review tunnel has one fixed port: **4173**. Check whether something is already listening there, and if so, **surface it to the owner instead of killing it**:
   ```sh
   lsof -nP -iTCP:4173 -sTCP:LISTEN
   ```
   Tell him what is running there (process name, command line, PID, and how long it has been up if he may not recognise it) and ask whether to leave it alone or shut it down. Wait for his answer — he may handle it himself. If he tells you to stop it, kill it and verify the listener is gone:
   ```sh
   lsof -ti:4173 | xargs -r kill
   ```
   Alternatively, `fuser -k 4173/tcp` can kill the listener, followed by `lsof -nP -iTCP:4173 -sTCP:LISTEN` to confirm. Never work around an occupied port by choosing a different one. Once the port is free — or the owner has told you to proceed — pick up here and continue with step 2.
2. Start the app's dev server on **port 4173**, bound to **127.0.0.1**, serving **plain HTTP**. TLS terminates at Cloudflare; a self-signed HTTPS origin fails through the tunnel. Run it in the background, save its PID, and redirect output to a log you can tail while checking it:
   ```sh
   <dev-server-command> > /tmp/review-dev-site.log 2>&1 &
   echo $! > /tmp/review-dev-site.pid
   tail -f /tmp/review-dev-site.log
   ```
   Use the framework's options/configuration to set the host and port; don't expose the server on other interfaces.
3. For Vite, configure the hostname and tunneled HMR explicitly:
   ```js
   server: {
     host: '127.0.0.1',
     port: 4173,
     strictPort: true,
     allowedHosts: ['dev.christophermeyer.dev'],
     hmr: { protocol: 'wss', clientPort: 443 },
   }
   ```
   The tunnel forwards `dev.christophermeyer.dev` as the origin `Host`, so Vite must allow it. HMR uses secure WebSockets through the tunnel. Ensure the page uses relative URLs, never an absolute `http://localhost:4173` base, or it will point the owner's phone at itself.
4. Check the log and confirm the server is listening on 127.0.0.1:4173. Tell the owner it is ready and to open **https://dev.christophermeyer.dev**. The existing Cloudflare tunnel forwards that hostname to `localhost:4173`; Cloudflare Access gates it to the owner's account, so only the owner can see the site.
5. Wait for the owner to finish the review. Then stop the server using its saved PID (or stop the specific process you started), and verify nothing is listening on 4173:
   ```sh
   lsof -nP -iTCP:4173 -sTCP:LISTEN
   ```
   Do not leave a review server running after the session.
