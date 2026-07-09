import { IncomingMessage, ServerResponse } from "node:http";
import * as client from "openid-client";

export interface OidcConsumerConfig {
  /** The provider's issuer URL for discovery (e.g. "http://localhost:9000") */
  providerUrl: string;
  /** OAuth client ID registered with the provider */
  clientId: string;
  /** OAuth client secret */
  clientSecret: string;
  /** Absolute redirect URI for the callback endpoint */
  redirectUri: string;
  /** Absolute URI to redirect to after logout */
  postLogoutRedirectUri: string;
  /** Scopes to request. Defaults to "openid profile email" */
  scopes?: string;
}

export type NodeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

/**
 * Creates an OIDC consumer (relying party) that handles login, callback, and displays token claims.
 * Returns a plain Node HTTP handler. Routes are relative to wherever this handler is mounted.
 */
export function createOidcConsumer(config: OidcConsumerConfig): NodeHandler {
  const {
    providerUrl,
    clientId,
    clientSecret,
    redirectUri,
    postLogoutRedirectUri,
    scopes = "openid profile email",
  } = config;

  /** In-memory store for pending auth flows, keyed by state */
  const pendingFlows = new Map<string, { codeVerifier: string }>();

  /** Lazily-resolved provider configuration */
  let configPromise: Promise<client.Configuration> | undefined;

  function getConfig(): Promise<client.Configuration> {
    if (!configPromise) {
      configPromise = discoverWithRetry(providerUrl, clientId, clientSecret);
    }
    return configPromise;
  }

  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/" && method === "GET") {
      serveHomePage(res);
      return;
    }

    if (path === "/login" && method === "GET") {
      await handleLogin(res, getConfig, redirectUri, scopes, pendingFlows);
      return;
    }

    if (path === "/callback" && method === "GET") {
      await handleCallback(url, res, getConfig, redirectUri, pendingFlows);
      return;
    }

    if (path === "/logout" && method === "GET") {
      await handleLogout(res, getConfig, clientId, postLogoutRedirectUri);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  };
}

// --- Route handlers ---

function serveHomePage(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>OIDC Consumer</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 500px; margin: 80px auto; text-align: center; }
  a { display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 4px; font-size: 16px; }
  a:hover { background: #0052a3; }
</style>
</head>
<body>
  <h1>OIDC Test Consumer</h1>
  <p>Click below to authenticate via the OIDC provider.</p>
  <a href="login">Login with OIDC</a>
</body>
</html>`);
}

async function handleLogin(
  res: ServerResponse,
  getConfig: () => Promise<client.Configuration>,
  redirectUri: string,
  scopes: string,
  pendingFlows: Map<string, { codeVerifier: string }>,
): Promise<void> {
  try {
    const oidcConfig = await getConfig();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    pendingFlows.set(state, { codeVerifier });

    const redirectTo = client.buildAuthorizationUrl(oidcConfig, {
      redirect_uri: redirectUri,
      scope: scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    res.writeHead(302, { Location: redirectTo.href });
    res.end();
  } catch (err) {
    console.error("Login error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to start login flow");
  }
}

async function handleCallback(
  url: URL,
  res: ServerResponse,
  getConfig: () => Promise<client.Configuration>,
  redirectUri: string,
  pendingFlows: Map<string, { codeVerifier: string }>,
): Promise<void> {
  try {
    const state = url.searchParams.get("state");
    if (!state || !pendingFlows.has(state)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid or expired state parameter");
      return;
    }

    const { codeVerifier } = pendingFlows.get(state)!;
    pendingFlows.delete(state);

    // Reconstruct callback URL with query params as the client library expects
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = url.search;

    const oidcConfig = await getConfig();
    const tokens = await client.authorizationCodeGrant(
      oidcConfig,
      callbackUrl,
      {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
      },
    );

    const userinfo = await client.fetchUserInfo(
      oidcConfig,
      tokens.access_token,
      tokens.claims()!.sub,
    );

    const idClaims = tokens.claims();

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Login Successful</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 600px; margin: 80px auto; }
  pre { background: #f4f4f4; padding: 16px; border-radius: 4px; overflow-x: auto; }
  a { color: #0066cc; }
  .logout { color: #cc3300; }
</style>
</head>
<body>
  <h1>Login Successful</h1>
  <h2>ID Token Claims</h2>
  <pre>${escapeHtml(JSON.stringify(idClaims, null, 2))}</pre>
  <h2>UserInfo</h2>
  <pre>${escapeHtml(JSON.stringify(userinfo, null, 2))}</pre>
  <p><a href="./">Back to home</a></p>
  <p><a href="logout" class="logout">Logout</a></p>
</body>
</html>`);
  } catch (err) {
    console.error("Callback error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Authentication failed");
  }
}

async function handleLogout(
  res: ServerResponse,
  getConfig: () => Promise<client.Configuration>,
  clientId: string,
  postLogoutRedirectUri: string,
): Promise<void> {
  try {
    const oidcConfig = await getConfig();
    const metadata = oidcConfig.serverMetadata();
    const endSessionUrl = metadata.end_session_endpoint;

    if (!endSessionUrl) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Provider does not support RP-initiated logout");
      return;
    }

    const url = new URL(endSessionUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);

    res.writeHead(302, { Location: url.href });
    res.end();
  } catch (err) {
    console.error("Logout error:", err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to initiate logout");
  }
}

// --- Utilities ---

/** Retry discovery until the provider is reachable */
async function discoverWithRetry(
  providerUrl: string,
  clientId: string,
  clientSecret: string,
  retries = 10,
  delayMs = 1000,
): Promise<client.Configuration> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.discovery(
        new URL(providerUrl),
        clientId,
        clientSecret,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        { execute: [client.allowInsecureRequests] },
      );
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`Waiting for provider (attempt ${attempt}/${retries})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("unreachable");
}

/** Prevent XSS in rendered claim values */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
