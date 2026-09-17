import 'dotenv/config'
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAuthorizeUrl,
  getGitHubOAuthCredentials,
  GitHubOAuthError,
} from '../src/auth/github-oauth.js'
import type { Config } from '../src/config.js'

describe('GitHub OAuth helper', () => {
  test('buildAuthorizeUrl creates valid URL with correct scopes and parameters', () => {
    const url = buildAuthorizeUrl({
      clientId: 'gh_client_123',
      state: 'random_state_xyz',
      redirectUri: 'https://fleetapp.test/api/auth/github/callback',
    })

    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://github.com')
    assert.equal(parsed.pathname, '/login/oauth/authorize')
    assert.equal(parsed.searchParams.get('client_id'), 'gh_client_123')
    assert.equal(parsed.searchParams.get('state'), 'random_state_xyz')
    assert.equal(parsed.searchParams.get('scope'), 'read:user user:email')
    assert.equal(parsed.searchParams.get('redirect_uri'), 'https://fleetapp.test/api/auth/github/callback')
  })

  test('buildAuthorizeUrl without redirectUri relies on GitHub App configured callback', () => {
    const url = buildAuthorizeUrl({
      clientId: 'gh_client_456',
      state: 'state_without_redirect',
    })

    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('client_id'), 'gh_client_456')
    assert.equal(parsed.searchParams.get('state'), 'state_without_redirect')
    assert.equal(parsed.searchParams.has('redirect_uri'), false)
  })

  test('getGitHubOAuthCredentials returns null when credentials missing', () => {
    const emptyConfig = {} as unknown as Config
    const originalEnvId = process.env.GITHUB_CLIENT_ID
    const originalEnvSecret = process.env.GITHUB_CLIENT_SECRET
    delete process.env.GITHUB_CLIENT_ID
    delete process.env.GITHUB_CLIENT_SECRET

    try {
      const creds = getGitHubOAuthCredentials(emptyConfig)
      assert.equal(creds, null)
    } finally {
      if (originalEnvId) process.env.GITHUB_CLIENT_ID = originalEnvId
      if (originalEnvSecret) process.env.GITHUB_CLIENT_SECRET = originalEnvSecret
    }
  })

  test('getGitHubOAuthCredentials reads from config or env', () => {
    const config = {
      GITHUB_APP_CLIENT_ID: 'test_client_id',
      GITHUB_APP_CLIENT_SECRET: 'test_client_secret',
    } as unknown as Config

    const creds = getGitHubOAuthCredentials(config)
    assert.ok(creds)
    assert.equal(creds?.clientId, 'test_client_id')
    assert.equal(creds?.clientSecret, 'test_client_secret')
  })

  test('GitHubOAuthError contains code and status', () => {
    const err = new GitHubOAuthError('Failed to exchange token', 'token_exchange_error', 401)
    assert.equal(err.code, 'token_exchange_error')
    assert.equal(err.status, 401)
    assert.equal(err.message, 'Failed to exchange token')
  })
})
