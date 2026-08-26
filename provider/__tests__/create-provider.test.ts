import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startProvider,
  createCookieJar,
  fetchWithCookies,
  generateCodeVerifier,
  calculateCodeChallenge,
  generateState,
  TEST_ACCOUNTS,
  TEST_CLIENT,
  type TestServer,
} from "./helpers.js";

describe("createOidcProvider", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startProvider();
  });

  afterAll(async () => {
    await server.close();
  });

  describe("discovery", () => {
    it("returns 200 with correct issuer", async () => {
      const res = await fetch(
        `${server.baseUrl}/.well-known/openid-configuration`,
      );
      expect(res.status).toBe(200);
      const metadata = await res.json();
      expect(metadata.issuer).toBe(server.baseUrl);
    });

    it("includes authorization, token, and userinfo endpoints", async () => {
      const res = await fetch(
        `${server.baseUrl}/.well-known/openid-configuration`,
      );
      const metadata = await res.json();
      expect(metadata.authorization_endpoint).toBe(`${server.baseUrl}/auth`);
      expect(metadata.token_endpoint).toBe(`${server.baseUrl}/token`);
      expect(metadata.userinfo_endpoint).toBe(`${server.baseUrl}/me`);
    });

    it("scopes_supported matches configured scopes", async () => {
      const res = await fetch(
        `${server.baseUrl}/.well-known/openid-configuration`,
      );
      const metadata = await res.json();
      expect(metadata.scopes_supported).toContain("openid");
      expect(metadata.scopes_supported).toContain("profile");
      expect(metadata.scopes_supported).toContain("email");
    });

    it("code_challenge_methods_supported includes S256", async () => {
      const res = await fetch(
        `${server.baseUrl}/.well-known/openid-configuration`,
      );
      const metadata = await res.json();
      expect(metadata.code_challenge_methods_supported).toContain("S256");
    });
  });

  describe("interaction", () => {
    it("GET /auth redirects to /interaction/:uid", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();
      const res = await fetchWithCookies(authUrl, {}, jar);

      expect(res.status).toBe(303);
      const location = res.headers.get("location")!;
      expect(location).toMatch(/\/interaction\/[a-zA-Z0-9_-]+/);
    });

    it("GET /interaction/:uid returns HTML with account picker", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();
      const authRes = await fetchWithCookies(authUrl, {}, jar);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );

      const res = await fetchWithCookies(interactionUrl, {}, jar);
      expect(res.status).toBe(200);

      const html = await res.text();
      expect(html).toContain("Pre-configured account");
    });

    it("account picker shows all configured accounts", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();
      const authRes = await fetchWithCookies(authUrl, {}, jar);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );

      const res = await fetchWithCookies(interactionUrl, {}, jar);
      const html = await res.text();

      for (const account of TEST_ACCOUNTS) {
        expect(html).toContain(account.email);
        expect(html).toContain(account.sub);
      }
    });

    it("POST /interaction/:uid/login with valid accountId redirects", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();
      const authRes = await fetchWithCookies(authUrl, {}, jar);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );

      // Load interaction page (needed to establish interaction session)
      await fetchWithCookies(interactionUrl, {}, jar);

      // POST login
      const loginUrl = `${interactionUrl}/login`;
      const res = await fetchWithCookies(
        loginUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "account=alice-001",
        },
        jar,
      );

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/auth/");
    });

    it("POST /interaction/:uid/login without accountId returns 400", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();
      const authRes = await fetchWithCookies(authUrl, {}, jar);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );

      await fetchWithCookies(interactionUrl, {}, jar);

      const loginUrl = `${interactionUrl}/login`;
      const res = await fetchWithCookies(
        loginUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
        },
        jar,
      );

      expect(res.status).toBe(400);
    });
  });

  describe("custom configuration", () => {
    let customServer: TestServer;

    const customAccounts = [
      { sub: "custom-001", name: "Custom User", email: "custom@example.com" },
    ];

    beforeAll(async () => {
      customServer = await startProvider({
        accounts: customAccounts,
        scopes: "openid email",
      });
    });

    afterAll(async () => {
      await customServer.close();
    });

    it("custom scopes are reflected in discovery metadata", async () => {
      const res = await fetch(
        `${customServer.baseUrl}/.well-known/openid-configuration`,
      );
      const metadata = await res.json();
      expect(metadata.scopes_supported).toContain("openid");
      expect(metadata.scopes_supported).toContain("email");
    });

    it("custom accounts appear in the picker", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(customServer.baseUrl, { challenge, state });
      const jar = createCookieJar();
      const authRes = await fetchWithCookies(authUrl, {}, jar);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );

      const res = await fetchWithCookies(interactionUrl, {}, jar);
      const html = await res.text();

      expect(html).toContain("custom@example.com");
      expect(html).toContain("custom-001");
    });
  });

  describe("full OIDC flow", () => {
    it("completes auth code + PKCE flow end-to-end", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();

      // 1. GET /auth → redirect to interaction
      const authRes = await fetchWithCookies(authUrl, {}, jar);
      expect(authRes.status).toBe(303);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );

      // 2. GET interaction page
      await fetchWithCookies(interactionUrl, {}, jar);

      // 3. POST login
      const loginUrl = `${interactionUrl}/login`;
      const loginRes = await fetchWithCookies(
        loginUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "account=alice-001",
        },
        jar,
      );
      expect(loginRes.status).toBe(303);

      // 4. Follow auth resume → redirect to callback with code + state
      const resumeUrl = resolveUrl(loginRes.headers.get("location")!, loginUrl);
      const resumeRes = await fetchWithCookies(resumeUrl, {}, jar);
      expect(resumeRes.status).toBe(303);

      const callbackUrl = new URL(resumeRes.headers.get("location")!);
      expect(callbackUrl.searchParams.get("state")).toBe(state);
      expect(callbackUrl.searchParams.get("code")).toBeTruthy();

      const code = callbackUrl.searchParams.get("code")!;

      // 5. Token exchange
      const tokenRes = await fetch(`${server.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${server.baseUrl}/callback`,
          code_verifier: verifier,
          client_id: TEST_CLIENT.client_id,
          client_secret: TEST_CLIENT.client_secret,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);

      const tokens = await tokenRes.json();
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.id_token).toBeTruthy();
      expect(tokens.token_type).toBe("Bearer");

      // 6. UserInfo
      const userinfoRes = await fetch(`${server.baseUrl}/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      expect(userinfoRes.status).toBe(200);

      const userinfo = await userinfoRes.json();
      expect(userinfo.sub).toBe("alice-001");
      expect(userinfo.name).toBe("Alice Smith");
      expect(userinfo.email).toBe("alice@example.com");
    });

    it("verifies id_token contains correct sub claim", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();

      const authRes = await fetchWithCookies(authUrl, {}, jar);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );
      await fetchWithCookies(interactionUrl, {}, jar);

      const loginRes = await fetchWithCookies(
        `${interactionUrl}/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "account=bob-001",
        },
        jar,
      );

      const resumeUrl = resolveUrl(
        loginRes.headers.get("location")!,
        interactionUrl,
      );
      const resumeRes = await fetchWithCookies(resumeUrl, {}, jar);
      const callbackUrl = new URL(resumeRes.headers.get("location")!);
      const code = callbackUrl.searchParams.get("code")!;

      const tokenRes = await fetch(`${server.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${server.baseUrl}/callback`,
          code_verifier: verifier,
          client_id: TEST_CLIENT.client_id,
          client_secret: TEST_CLIENT.client_secret,
        }).toString(),
      });

      const tokens = await tokenRes.json();
      // Decode JWT payload (id_token is a JWS — header.payload.signature)
      const payload = JSON.parse(
        Buffer.from(tokens.id_token.split(".")[1], "base64url").toString(),
      );
      expect(payload.sub).toBe("bob-001");
      expect(payload.aud).toBe(TEST_CLIENT.client_id);
      expect(payload.iss).toBe(server.baseUrl);
    });

    it("rejects invalid PKCE verifier", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const authUrl = buildAuthUrl(server.baseUrl, { challenge, state });
      const jar = createCookieJar();

      const authRes = await fetchWithCookies(authUrl, {}, jar);
      const interactionUrl = resolveUrl(
        authRes.headers.get("location")!,
        authUrl,
      );
      await fetchWithCookies(interactionUrl, {}, jar);

      const loginRes = await fetchWithCookies(
        `${interactionUrl}/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "account=alice-001",
        },
        jar,
      );

      const resumeUrl = resolveUrl(
        loginRes.headers.get("location")!,
        interactionUrl,
      );
      const resumeRes = await fetchWithCookies(resumeUrl, {}, jar);
      const callbackUrl = new URL(resumeRes.headers.get("location")!);
      const code = callbackUrl.searchParams.get("code")!;

      // Use a WRONG verifier
      const tokenRes = await fetch(`${server.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${server.baseUrl}/callback`,
          code_verifier: "wrong-verifier-that-does-not-match",
          client_id: TEST_CLIENT.client_id,
          client_secret: TEST_CLIENT.client_secret,
        }).toString(),
      });

      expect(tokenRes.status).toBe(400);
      const body = await tokenRes.json();
      expect(body.error).toBe("invalid_request");
    });

    it("rejects unknown client_id at auth endpoint", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await calculateCodeChallenge(verifier);
      const state = generateState();

      const url = new URL("/auth", server.baseUrl);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", "nonexistent-client");
      url.searchParams.set("redirect_uri", `${server.baseUrl}/callback`);
      url.searchParams.set("scope", "openid");
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", state);

      const res = await fetch(url.href, { redirect: "manual" });
      // oidc-provider returns an error page (not a redirect) for unknown clients
      expect(res.status).toBe(400);
    });
  });
});

// --- Helpers local to this test file ---

function buildAuthUrl(
  baseUrl: string,
  params: { challenge: string; state: string },
): string {
  const url = new URL("/auth", baseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", TEST_CLIENT.client_id);
  url.searchParams.set("redirect_uri", `${baseUrl}/callback`);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.href;
}

function resolveUrl(location: string, base: string): string {
  if (location.startsWith("http")) return location;
  return new URL(location, base).href;
}
