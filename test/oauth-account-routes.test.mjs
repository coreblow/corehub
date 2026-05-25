import assert from "node:assert/strict";
import { startCoreHubTestServer } from "./helpers/corehub-testkit.mjs";

const oauthCalls = [];
const server = await startCoreHubTestServer({
  oauth: {
    githubClientId: "corehub-test-client",
    githubClientSecret: "corehub-test-secret",
    githubAuthorizeUrl: "https://github.example.invalid/login/oauth/authorize",
    githubTokenUrl: "https://github.example.invalid/login/oauth/access_token",
    githubUserUrl: "https://api.github.example.invalid/user",
    sessionTtlMs: 60 * 60 * 1000,
    async fetch(url, init = {}) {
      oauthCalls.push({ url: String(url), init });
      if (String(url).includes("/login/oauth/access_token")) {
        assert.match(String(init.body), /client_id=corehub-test-client/);
        assert.match(String(init.body), /code=oauth-code-fixture/);
        return Response.json({ access_token: "github-access-token-fixture", token_type: "bearer" });
      }
      if (String(url).includes("/user")) {
        assert.equal(init.headers.authorization, "Bearer github-access-token-fixture");
        return Response.json({
          id: 98765,
          login: "octo-web",
          name: "Octo Web",
          avatar_url: "https://avatars.example.invalid/octo-web.png",
          html_url: "https://github.com/octo-web",
          created_at: "2020-01-01T00:00:00Z",
        });
      }
      return new Response("not found", { status: 404 });
    },
  },
});

try {
  const start = await fetch(`${server.v2Url}/oauth/github/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirectUri: `${server.corehubUrl}/api/v2/oauth/github/callback`,
      label: "Browser login fixture",
    }),
  });
  assert.equal(start.status, 200);
  const startPayload = await start.json();
  assert.equal(startPayload.data.provider, "github");
  assert.match(startPayload.data.authorizationUrl, /^https:\/\/github\.example\.invalid\/login\/oauth\/authorize/);
  assert.match(startPayload.data.authorizationUrl, /client_id=corehub-test-client/);
  assert.match(startPayload.data.state, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const exchange = await fetch(`${server.v2Url}/oauth/github/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "oauth-code-fixture",
      state: startPayload.data.state,
      redirectUri: startPayload.data.redirectUri,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const exchangePayload = await exchange.json();
  assert.equal(exchangePayload.data.account.actorId, "github:octo-web");
  assert.equal(exchangePayload.data.publisher.handle, "octo-web");
  assert.equal(exchangePayload.data.session.provider, "github-oauth");
  assert.equal(exchangePayload.data.session.label, "Browser login fixture");
  assert.match(exchangePayload.data.session.tokenHash, /^[a-f0-9]{64}$/);
  assert.match(exchangePayload.data.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const account = await fetch(`${server.v2Url}/account/me`, {
    headers: { authorization: `Bearer ${exchangePayload.data.token}` },
  });
  assert.equal(account.status, 200);
  const accountPayload = await account.json();
  assert.equal(accountPayload.data.authenticated, true);
  assert.equal(accountPayload.data.identity.defaultPublisher.handle, "octo-web");

  const session = await fetch(`${server.v2Url}/session/validate?role=publisher`, {
    headers: { authorization: `Bearer ${exchangePayload.data.token}` },
  });
  assert.equal(session.status, 200);
  const sessionPayload = await session.json();
  assert.equal(sessionPayload.data.token.type, "jwt");
  assert.equal(sessionPayload.data.actor.id, "github:octo-web");
  assert.equal(sessionPayload.data.defaultPublisher.handle, "octo-web");
  assert.equal(oauthCalls.length, 2);
} finally {
  await server.close();
}

const unconfigured = await startCoreHubTestServer();
try {
  const start = await fetch(`${unconfigured.v2Url}/oauth/github/start`, { method: "POST" });
  assert.equal(start.status, 503);
  assert.match((await start.json()).error, /GitHub OAuth client id/);
} finally {
  await unconfigured.close();
}
