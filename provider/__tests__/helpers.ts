import { createServer } from "node:http";
import crypto from "node:crypto";
import {
  createOidcProvider,
  type OidcProviderConfig,
  type OidcAccount,
} from "../create-provider.js";
import { ClientMetadata } from "oidc-provider";

// --- Test defaults ---

export const TEST_ACCOUNTS: readonly OidcAccount[] = [
  { sub: "alice-001", name: "Alice Smith", email: "alice@example.com" },
  { sub: "bob-001", name: "Bob Jones", email: "bob@example.com" },
];

export const TEST_CLIENT: ClientMetadata = {
  client_id: "test-client",
  client_secret: "test-secret",
  redirect_uris: ["http://localhost:0/callback"],
};

function generateJwks(): { keys: JsonWebKey[] } {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = privateKey.export({ format: "jwk" });
  return { keys: [{ ...jwk, use: "sig", alg: "RS256" }] };
}

// --- Server lifecycle ---

export interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** Starts a provider on a random port with sensible test defaults */
export function startProvider(
  overrides: Partial<OidcProviderConfig> = {},
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const config: OidcProviderConfig = {
      issuer: "http://localhost:0", // placeholder, replaced after listen
      accounts: TEST_ACCOUNTS,
      clients: [TEST_CLIENT],
      jwks: generateJwks(),
      ...overrides,
    };

    // We need the actual port before creating the provider (issuer must match)
    // So: start a temp server to grab a port, close it, then create provider with correct issuer
    const tempServer = createServer();
    tempServer.listen(0, () => {
      const port = (tempServer.address() as { port: number }).port;
      tempServer.close(() => {
        const baseUrl = `http://localhost:${port}`;

        // Update client redirect URIs to use the actual port
        const clients = config.clients.map((c) => ({
          ...c,
          redirect_uris: c.redirect_uris?.map((uri:string) =>
            uri.replace("localhost:0", `localhost:${port}`),
          ),
        }));

        const handler = createOidcProvider({
          ...config,
          issuer: baseUrl,
          clients,
        });

        // Async handlers in createServer are standard — the promise is intentionally fire-and-forget
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        const server = createServer(handler);
        server.listen(port);
        server.on("listening", () => {
          resolve({
            baseUrl,
            close: () =>
              new Promise<void>((res, rej) => {
                server.close((err) => {
                  if (err) {
                    rej(err);
                  } else {
                    res();
                  }
                });
              }),
          });
        });
        server.on("error", reject);
      });
    });
    tempServer.on("error", reject);
  });
}

// --- Cookie jar fetch ---

export type CookieJar = Map<string, string>;

/** Creates a fresh cookie jar */
export function createCookieJar(): CookieJar {
  return new Map();
}

/** Fetch that doesn't follow redirects and manages cookies via a jar */
export async function fetchWithCookies(
  url: string,
  options: RequestInit = {},
  jar: CookieJar = new Map(),
): Promise<Response> {
  const cookieHeader = [...jar.values()].join("; ");

  const headers = new Headers(options.headers);
  if (cookieHeader) {
    headers.set("Cookie", cookieHeader);
  }

  const response = await fetch(url, {
    ...options,
    headers,
    redirect: "manual",
  });

  // Collect set-cookie headers into the jar
  const setCookies = response.headers.getSetCookie();
  for (const cookie of setCookies) {
    const [nameValue] = cookie.split(";");
    const [name] = nameValue.split("=");
    jar.set(name.trim(), nameValue.trim());
  }

  return response;
}

/** Resolves a possibly-relative Location header against the request URL */
function resolveLocation(location: string, requestUrl: string): string {
  if (location.startsWith("http")) return location;
  const base = new URL(requestUrl);
  return new URL(location, base).href;
}

export interface RedirectChain {
  responses: Response[];
  urls: string[];
  finalResponse: Response;
  finalUrl: string;
}

/** Follows redirects manually, accumulating cookies. Stops at a non-redirect or maxHops. */
export async function followRedirects(
  startUrl: string,
  options: {
    jar?: CookieJar;
    maxHops?: number;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<RedirectChain> {
  const jar = options.jar ?? createCookieJar();
  const maxHops = options.maxHops ?? 20;
  const responses: Response[] = [];
  const urls: string[] = [];

  let currentUrl = startUrl;
  let currentOptions: RequestInit = {
    method: options.method,
    body: options.body,
    headers: options.headers,
  };

  for (let i = 0; i < maxHops; i++) {
    const response = await fetchWithCookies(currentUrl, currentOptions, jar);
    responses.push(response);
    urls.push(currentUrl);

    const location = response.headers.get("location");
    if (
      !location ||
      (response.status !== 301 &&
        response.status !== 302 &&
        response.status !== 303)
    ) {
      return { responses, urls, finalResponse: response, finalUrl: currentUrl };
    }

    currentUrl = resolveLocation(location, currentUrl);
    // After redirect, switch to GET (303 semantics, also safe for 302 in practice)
    currentOptions = {};
  }

  const last = responses[responses.length - 1];
  return { responses, urls, finalResponse: last, finalUrl: currentUrl };
}

// --- PKCE helpers ---

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function calculateCodeChallenge(verifier: string): Promise<string> {
  const digest = crypto.createHash("sha256").update(verifier).digest();
  return Promise.resolve(digest.toString("base64url"));
}

export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}
