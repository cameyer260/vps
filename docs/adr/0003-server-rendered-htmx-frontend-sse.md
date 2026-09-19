# Server-rendered htmx frontend with SSE streams, no WebSocket

The React SPA is replaced by Askama-rendered HTML fragments over htmx with
hyperscript for the few interactive touches (autoscroll, disabled send).
Chat is server-rendered: the Rust bridge owns entry state and renders every
entry (user, assistant, tool calls, notices) to sanitized HTML server-side
(pulldown-cmark + ammonia), streaming updates to clients as SSE events
(`init`, `entry`, `delta`, `status`, `notice`); deltas are coalesced
server-side (~50–100ms) and the client just swaps fragments — no client-side
chat state machine, no provisional-vs-committed duality, no client markdown
renderer. Commands (prompt, model pick, terminate, read-only toggle) are
plain hx-post form submissions; uploads become ordinary multipart POSTs.

Server→client streams elsewhere follow the same rule: the global agent feed
(old /ws/events) is a second SSE endpoint driving the sidebar. The two JS
modules originally planned (chat WS client, event bridge) are not needed —
htmx's SSE extension consumes streams directly; hyperscript covers remaining
interactivity. No WebSocket anywhere (client→server is always discrete
submits; if a future feature needs client→server streaming, e.g. voice, it
gets its own WS then).

Trade-offs accepted: more bytes on the wire (fragments vs deltas) and
server CPU per coalesced re-render — negligible for a single-user dashboard
on the VPS; Cloudflare's ~100s idle timeout requires SSE keepalive pings
(~15–30s), verified once at deploy.
