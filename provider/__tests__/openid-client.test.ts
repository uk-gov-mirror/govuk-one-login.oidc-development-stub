import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as client from "openid-client";
import {
  startProvider,
  createCookieJar,
  fetchWithCookies,
  TEST_CLIENT,
  type TestServer,
} from "./helpers.js";

describe("openid-client integration", () => {
  let server: TestServer;
  let config: client.Configuration;

  beforeAll(async () => {
    server = await startProvider();
    config = await client.discovery(
      new URL(server.baseUrl),
      TEST_CLIENT.client_id,
      TEST_CLIENT.client_secret,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      { execute: [client.allowInsecureRequests] },
    );
  });

  afterAll(async () => {
    await server.close();
  });

  it("discovers provider metadata with correct issuer", () => {
    const metadata = config.serverMetadata();
    expect(metadata.issuer).toBe(server.baseUrl);
    expect(metadata.authorization_endpoint).toBeTruthy();
    expect(metadata.token_endpoint).toBeTruthy();
    expect(metadata.userinfo_endpoint).toBeTruthy();
  });

  it("completes full auth code + PKCE flow via openid-client", async () => {
    // 1. Build authorization URL with PKCE
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const redirectUri = `${server.baseUrl}/callback`;

    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    // 2. Simulate browser: follow auth → interaction → login → callback
    const callbackUrl = await simulateLogin(authUrl.href, "alice-001");

    // 3. Use openid-client to exchange the code (validates signatures, issuer, etc.)
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });

    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeTruthy();

    // 4. Verify id_token claims via openid-client's parsed claims
    const claims = tokens.claims()!;
    expect(claims.sub).toBe("alice-001");
    expect(claims.aud).toBe(TEST_CLIENT.client_id);
    expect(claims.iss).toBe(server.baseUrl);

    // 5. Fetch userinfo via openid-client
    const userinfo = await client.fetchUserInfo(
      config,
      tokens.access_token,
      claims.sub,
    );

    expect(userinfo.sub).toBe("alice-001");
    expect(userinfo.name).toBe("Alice Smith");
    expect(userinfo.email).toBe("alice@example.com");
  });

  it("works with different accounts", async () => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: `${server.baseUrl}/callback`,
      scope: "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    const callbackUrl = await simulateLogin(authUrl.href, "bob-001");

    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });

    const claims = tokens.claims()!;
    expect(claims.sub).toBe("bob-001");

    const userinfo = await client.fetchUserInfo(
      config,
      tokens.access_token,
      claims.sub,
    );

    expect(userinfo.sub).toBe("bob-001");
    expect(userinfo.name).toBe("Bob Jones");
    expect(userinfo.email).toBe("bob@example.com");
  });

  it("openid-client rejects tampered state", async () => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: `${server.baseUrl}/callback`,
      scope: "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    const callbackUrl = await simulateLogin(authUrl.href, "alice-001");

    // Attempt grant with wrong expected state — openid-client should reject
    await expect(
      client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: codeVerifier,
        expectedState: "tampered-state-value",
      }),
    ).rejects.toThrow();
  });

  it("token has valid expiry claims", async () => {
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: `${server.baseUrl}/callback`,
      scope: "openid profile email",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    const callbackUrl = await simulateLogin(authUrl.href, "alice-001");

    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState: state,
    });

    const claims = tokens.claims()!;
    const now = Math.floor(Date.now() / 1000);

    expect(claims.iat).toBeDefined();
    expect(claims.exp).toBeDefined();
    expect(claims.iat).toBeLessThanOrEqual(now + 5); // issued recently
    expect(claims.exp).toBeGreaterThan(now); // not yet expired
  });

  // --- Helper: simulates the browser interaction (redirect + login) ---

  async function simulateLogin(
    authUrl: string,
    accountId: string,
  ): Promise<URL> {
    const jar = createCookieJar();

    // Follow auth → interaction redirect
    const authRes = await fetchWithCookies(authUrl, {}, jar);
    const interactionUrl = resolveUrl(
      authRes.headers.get("location")!,
      authUrl,
    );

    // Load interaction page (establishes session)
    await fetchWithCookies(interactionUrl, {}, jar);

    // POST login
    const loginUrl = `${interactionUrl}/login`;
    const loginRes = await fetchWithCookies(
      loginUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `account=${accountId}`,
      },
      jar,
    );

    // Follow auth resume → get callback URL with code
    const resumeUrl = resolveUrl(loginRes.headers.get("location")!, loginUrl);
    const resumeRes = await fetchWithCookies(resumeUrl, {}, jar);

    return new URL(resumeRes.headers.get("location")!);
  }

  function resolveUrl(location: string, base: string): string {
    if (location.startsWith("http")) return location;
    return new URL(location, base).href;
  }
});
