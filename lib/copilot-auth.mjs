/**
 * GitHub Copilot authentication for vision-router's `httpProviders` chain.
 *
 * Copilot exposes an OpenAI-compatible Chat Completions API at
 * `https://api.githubcopilot.com/chat/completions`, but it does NOT accept
 * API keys: the bearer token is a short-lived Copilot JWT (~20 min) obtained
 * by exchanging a GitHub OAuth token at
 * `https://api.github.com/copilot_internal/v2/token`.
 *
 * This module implements the standard "log in with GitHub" device flow (the
 * same flow the official `copilot` CLI uses) so the user's own Copilot
 * subscription authorizes the vision calls:
 *
 *   1. GitHub OAuth device code  -> user visits github.com/login/device and
 *      enters the code (this is the explicit login authorization);
 *   2. poll for the GitHub access token (persisted to
 *      `$DSH_HOME/.copilot-oauth.json` so future runs skip the browser step);
 *   3. exchange it for the Copilot JWT; cache the JWT in memory and
 *      re-exchange before it expires (refresh_in ~1200s, 60s safety buffer);
 *   4. on a 401 the caller invalidates the cache and re-exchanges once.
 *
 * Headless alternative: set COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN to
 * a fine-grained PAT (v2) with the "Copilot Requests" permission, or to a
 * GitHub OAuth token from the Copilot CLI / gh app — the exchange accepts all
 * of them (documented by `copilot login --help`).
 *
 * The chat request itself needs a handful of editor-style headers plus
 * `copilot-vision-request: true` when any message carries an image; the
 * request body stays the ordinary OpenAI Chat Completions shape.
 *
 * No dependencies: plain `fetch`, zero npm packages.
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

/** The public OAuth app GitHub Copilot itself uses for device login. */
export const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
export const COPILOT_OAUTH_SCOPE = 'read:user'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

/** Chat endpoint the copilot httpProvider entries use. */
export const COPILOT_CHAT_BASE = 'https://api.githubcopilot.com'

/** Editor-style headers Copilot's chat completions endpoint expects. */
export const COPILOT_CHAT_HEADERS = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': 'vscode/1.104.3',
  'editor-plugin-version': 'copilot-chat/0.26.7',
  'user-agent': 'GitHubCopilotChat/0.26.7',
  'openai-intent': 'conversation-panel',
  'x-github-api-version': '2025-04-01',
  'x-vscode-user-agent-library-version': 'electron-fetch',
}

/** The exchange endpoint's own client headers (GitHub REST side). */
const EXCHANGE_HEADERS = {
  accept: 'application/json',
  'editor-version': 'vscode/1.104.3',
  'editor-plugin-version': 'copilot-chat/0.26.7',
  'user-agent': 'GitHubCopilotChat/0.26.7',
  'x-github-api-version': '2025-04-01',
}

/** Where the device-flow GitHub token is persisted (survives restarts). */
export function oauthFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, '.copilot-oauth.json')
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }, { once: true })
  })
}

async function postJson(url, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
  let data
  try {
    data = await response.json()
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data ?? '')
    throw new Error(`copilot oauth: ${response.status} ${String(detail).slice(0, 300)}`)
  }
  return data ?? {}
}

async function readOauthFile() {
  try {
    return JSON.parse(await readFile(oauthFile(), 'utf8'))
  } catch {
    return undefined
  }
}

async function writeOauthFile(data) {
  await mkdir(dirname(oauthFile()), { recursive: true })
  await writeFile(oauthFile(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

/** GitHub token from the environment (headless mode; PAT v2 with Copilot Requests). */
export function githubTokenFromEnv() {
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Run the GitHub OAuth device flow once. `onPrompt({ verificationUri,
 * userCode })` is called with the URL/code the user must authorize; the
 * returned promise resolves with the GitHub access token once the user
 * completes the browser step (or rejects on denial/timeout).
 */
export async function copilotLogin({ onPrompt, signal } = {}) {
  const existing = githubTokenFromEnv()
  if (existing) return existing

  const device = await postJson(DEVICE_CODE_URL, {
    client_id: COPILOT_CLIENT_ID,
    scope: COPILOT_OAUTH_SCOPE,
  })
  if (!device.device_code || !device.user_code) {
    throw new Error('copilot login: device code request returned an unexpected shape')
  }
  if (onPrompt) {
    await onPrompt({
      verificationUri: device.verification_uri ?? 'https://github.com/login/device',
      userCode: device.user_code,
    })
  }

  const intervalMs = Math.max(5, Number(device.interval ?? 5) + 1) * 1000
  const deadline = Date.now() + Number(device.expires_in ?? 899) * 1000
  while (Date.now() < deadline) {
    await sleep(intervalMs, signal)
    const result = await postJson(ACCESS_TOKEN_URL, {
      client_id: COPILOT_CLIENT_ID,
      device_code: device.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (typeof result.access_token === 'string' && result.access_token !== '') {
      await writeOauthFile({
        access_token: result.access_token,
        token_type: result.token_type ?? 'bearer',
        scope: result.scope ?? '',
        host: 'https://github.com',
        savedAt: new Date().toISOString(),
      })
      return result.access_token
    }
    const error = result.error
    if (error && error !== 'authorization_pending' && error !== 'slow_down') {
      const detail = result.error_description ?? ''
      throw new Error(`copilot login denied: ${error}${detail ? ` (${detail})` : ''}`)
    }
  }
  throw new Error('copilot login timed out: the device code expired before authorization completed')
}

/** Exchange a GitHub token (OAuth or fine-grained PAT) for a Copilot JWT. */
export async function exchangeCopilotToken(githubToken) {
  const response = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      authorization: `token ${githubToken}`,
      ...EXCHANGE_HEADERS,
    },
  })
  const text = await response.text().catch(() => '')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = undefined
  }
  if (!response.ok || !data || typeof data.token !== 'string' || data.token === '') {
    const detail = typeof data?.message === 'string' ? data.message : text.slice(0, 200)
    throw new Error(`copilot token exchange failed: ${response.status} ${detail}`)
  }
  return {
    token: data.token,
    expiresAt: Number(data.expires_at ?? 0) * 1000,
    refreshIn: Number(data.refresh_in ?? 1200),
  }
}

/** Whether any message in the OpenAI array carries an image_url block. */
export function messagesContainImage(messages) {
  return Array.isArray(messages) && messages.some((message) =>
    Array.isArray(message?.content) && message.content.some((block) =>
      block && typeof block === 'object' && block.type === 'image_url',
    ),
  )
}

/**
 * Per-process Copilot JWT cache with expiry-based refresh. A 401 caller
 * calls {@link invalidate} and retries once; the next `token()` re-exchanges.
 */
export class CopilotAuth {
  #jwt
  #expiresAt

  /** Resolve the GitHub token: env first, then the persisted device-flow token. */
  async githubToken() {
    const fromEnv = githubTokenFromEnv()
    if (fromEnv) return fromEnv
    const saved = await readOauthFile()
    if (saved && typeof saved.access_token === 'string' && saved.access_token !== '') {
      return saved.access_token
    }
    throw new Error(
      'copilot: no GitHub token available. Run the copilot-login device flow once ' +
      '(npx dsh-vision-router-copilot-login), or set COPILOT_GITHUB_TOKEN/GH_TOKEN to a ' +
      'fine-grained PAT with the "Copilot Requests" permission.',
    )
  }

  /** A valid Copilot JWT, exchanging/refreshing when missing or near expiry. */
  async token() {
    if (this.#jwt && this.#expiresAt && Date.now() < this.#expiresAt - 60_000) {
      return this.#jwt
    }
    const { token, expiresAt } = await exchangeCopilotToken(await this.githubToken())
    this.#jwt = token
    this.#expiresAt = expiresAt
    return token
  }

  /** Drop the cached JWT (called after a 401 so the next call re-exchanges). */
  invalidate() {
    this.#jwt = undefined
    this.#expiresAt = undefined
  }
}

let singleton
/** Process-wide Copilot auth used by the vision http chain. */
export function getCopilotAuth() {
  return (singleton ??= new CopilotAuth())
}

/** Human-readable auth status for the doctor / login CLI. */
export async function copilotAuthStatus() {
  const fromEnv = githubTokenFromEnv()
  if (fromEnv) return { method: 'env', githubToken: 'set' }
  const saved = await readOauthFile()
  if (saved && typeof saved.access_token === 'string' && saved.access_token !== '') {
    return { method: 'oauth-file', githubToken: 'saved', file: oauthFile() }
  }
  return { method: 'none', githubToken: 'missing' }
}
