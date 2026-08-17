#!/usr/bin/env node
/**
 * copilot-login — run the GitHub Copilot OAuth device flow once so
 * vision-router can use the user's Copilot subscription as a vision backend.
 *
 *   node scripts/copilot-login.mjs          interactive device flow
 *   node scripts/copilot-login.mjs --status  print the current auth status
 *
 * The GitHub access token is persisted to $DSH_HOME/.copilot-oauth.json
 * (mode 0600); the short-lived Copilot JWT is exchanged automatically on
 * every vision call and never stored.
 */

import { copilotLogin, copilotAuthStatus, githubTokenFromEnv } from '../lib/copilot-auth.mjs'

const args = process.argv.slice(2)
if (args.includes('--status') || args.includes('-s')) {
  const status = await copilotAuthStatus()
  const env = githubTokenFromEnv()
  console.log(`copilot auth: method=${status.method} githubToken=${status.githubToken}${status.file ? ` file=${status.file}` : ''}`)
  console.log(env ? 'env token: COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN is set (used first)' : 'env token: not set')
  process.exit(0)
}

console.log('GitHub Copilot login (device flow)')
console.log('----------------------------------')
try {
  const token = await copilotLogin({
    onPrompt: ({ verificationUri, userCode }) => {
      console.log(`1. Open:  ${verificationUri}`)
      console.log(`2. Enter code:  ${userCode}`)
      console.log('Waiting for you to authorize in the browser… (the flow times out after ~15 min)')
    },
  })
  console.log(`authorized (token ${token.slice(0, 7)}…${token.slice(-4)}), saved to ~/.dsh/.copilot-oauth.json`)
  console.log('Done. dsh-vision-router can now use Copilot as a vision backend.')
} catch (error) {
  console.error(`copilot login failed: ${error && error.message ? error.message : String(error)}`)
  process.exit(1)
}
