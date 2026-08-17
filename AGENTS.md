# AGENTS.md — fork maintenance notes

This repository is a **personal fork** of
[https://github.com/ysr666/dsh-vision-router](https://github.com/ysr666/dsh-vision-router)
(upstream). Working branch: `feat/copilot-vision`. The owner uses this fork
**locally only**, installed into the DeepSeek Harness web profile through a
`link:` dependency. When the owner asks to "update vision-router", follow the
Update workflow at the bottom.

## What this fork adds (never lose these)

- **GitHub Copilot vision transport** — `lib/copilot-auth.mjs`:
  GitHub OAuth **device-flow login** (token persisted to
  `~/.dsh/.copilot-oauth.json`), Copilot JWT exchange at
  `api.github.com/copilot_internal/v2/token` with expiry-based refresh, and
  the editor-style headers Copilot expects.
- **Responses-API transport** — `callCopilotResponses` in `index.js`
  (POST `{baseURL}/responses`, `stream: true`, `input_image` blocks,
  `max_output_tokens`, `copilot-vision-request: true`, one 401 re-exchange).
  Wired into the existing http chain: any `httpProviders` entry with
  `copilot: true` routes through it.
- **Settings-card Copilot section** — `lib/client.js` `copilotPanel()`:
  enable toggle, model, max tokens, login button (device flow shown inline),
  live test button; plus the `format`/`parse` branches for the
  `httpProviders` key and the `copilot*` locale strings (zh + en).
- **Server routes** — `/_dsh/vision-router/copilot-status`,
  `/_dsh/vision-router/copilot-login` (POST start / GET poll), and
  `/_dsh/vision-router/copilot-test` (real 1×1-pixel probe through
  `callCopilotResponses`).
- **Default model `gpt-5.6-luna`** — measured cheapest accurate Copilot
  vision model (0.0018 AIU/call; benchmark table lives in README).
- **Version `1.5.0-copilot.1`** — must stay **above** upstream's latest
  release so the plugin's built-in update check never offers the npm package.

## Local install (already set up on this machine)

- `~/.dsh/profiles/web/package.json` declares
  `"dsh-vision-router": "link:C:/Users/admin/dsh-vision-router"`.
- The fork's runtime dependencies live in **this directory's** `node_modules`
  (run `pnpm install` here after a fresh clone; the profile itself does not
  install them for `link:` deps).
- File changes take effect after the user restarts `dsh web` (no reinstall
  needed). The profile patch
  `~/.dsh/profiles/web/cordis.patch.yml` pre-configures the copilot
  `httpProviders` entry (model, `copilot: true`).

## Do NOT

- Do **not** run `dsh plugin --profile web add dsh-vision-router` — it
  replaces the link with the npm package and silently drops every fork
  feature.
- Do **not** use the plugin's one-click update in the settings card — it
  installs the npm package. Keeping the fork version above upstream prevents
  the prompt from appearing.
- Do **not** delete/move `C:\Users\admin\dsh-vision-router` without updating
  the link spec in `~/.dsh/profiles/web/package.json`.

## Update workflow (run when the owner asks to update)

1. `git -C C:\Users\admin\dsh-vision-router fetch upstream`
   then `git -C C:\Users\admin\dsh-vision-router merge upstream/main`.
2. Resolve conflicts, always keeping the fork features above: the copilot
   branches in `index.js`, `lib/copilot-auth.mjs`, and the `copilotPanel`
   section + `copilot*` keys in `lib/client.js`. If upstream refactors the
   settings card again, port `copilotPanel()` onto the new layout (keep
   upstream's other additions; do not regress their tests).
3. Bump `package.json` `version` above upstream's latest (e.g. upstream
   `1.5.0` → `1.5.1-copilot.1`); keep the `-copilot.` suffix and the fork
   description.
4. `npm test` in this directory — all tests must pass (node --test).
5. Smoke verify: boot `dsh web --port 0`, then check
   - `GET /_dsh/vision-router/copilot-status` → `method: "oauth-file"`,
     `configured: true`;
   - `POST /_dsh/vision-router/copilot-test` → `ok: true`, answer `OK`;
   - `GET /plugins/dsh-vision-router/client.js` → contains `copilotPanel`.
6. Commit (message should mention the upstream commits merged), push
   `origin feat/copilot-vision`, and tell the owner to restart `dsh web`.
