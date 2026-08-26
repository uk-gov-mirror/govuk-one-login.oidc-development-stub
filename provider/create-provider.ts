import { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import Koa from "koa";
import mount from "koa-mount";
import serve from "koa-static";
import Provider, { type ClientMetadata } from "oidc-provider";
import { interactionRoutes } from "./ui.js";
import { resolveAdapter, type AdapterConfig } from "./adapters/index.js";
import { nunjucksMiddleware } from "./nunjucks.js";

export type { AdapterConfig } from "./adapters/index.js";

export interface OidcAccount {
  sub: string;
  name: string;
  email: string;
  /** Additional claims to include in the id_token */
  tokenClaims?: Record<string, unknown>;
  /** Additional claims to include in the userinfo response */
  userinfoClaims?: Record<string, unknown>;
}
export interface OidcProviderConfig {
  /** The issuer URL (e.g. "http://localhost:9001") */
  issuer: string;
  /** Test accounts available in the account picker */
  accounts: readonly OidcAccount[];
  /** Pre-registered clients */
  clients: ClientMetadata[];
  /** Scopes to auto-grant on consent. Defaults to "openid profile email" */
  scopes?: string;
  /**
   * Custom claim names that accounts may include in tokenClaims/userinfoClaims.
   * Registered under the "profile" scope so the provider will emit them.
   * An error is thrown if any account uses a claim name not listed here.
   */
  customClaims?: string[];
  /** JWK Set for signing tokens. Suppresses the dev-keys warning when provided. */
  jwks?: { keys: JsonWebKey[] };
  /** Adapter config for persistence. Defaults to in-memory. */
  adapter?: AdapterConfig;
}

export type NodeHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

/**
 * Creates a self-contained OIDC provider with an account picker interaction.
 * Returns a plain Node HTTP handler that can be mounted in any framework.
 */
export function createOidcProvider(config: OidcProviderConfig): NodeHandler {
  const {
    issuer,
    accounts,
    clients,
    scopes = "openid profile email",
    customClaims = [],
    jwks,
    adapter: adapterConfig,
  } = config;

  validateCustomClaims(accounts, customClaims);

  const scopeList = scopes.split(" ");
  const claims = buildClaimsConfig(scopeList, customClaims);

  const provider = new Provider(issuer, {
    ...(jwks && { jwks }),

    adapter: resolveAdapter(adapterConfig),

    clients,

    findAccount: (_ctx, id) => {
      const account = accounts.find((a) => a.sub === id);
      if (!account) return undefined;

      return {
        accountId: account.sub,
        claims(use: string) {
          const base = {
            sub: account.sub,
            name: account.name,
            email: account.email,
          };

          const extra =
            use === "userinfo" ? account.userinfoClaims : account.tokenClaims;

          return { ...base, ...extra };
        },
      };
    },

    claims,

    features: {
      devInteractions: { enabled: false },
    },

    pkce: {
      methods: ["S256"],
      required: () => true,
    },

    async loadExistingGrant(ctx) {
      const { oidc } = ctx;
      const grantId =
        oidc.result?.consent?.grantId ??
        oidc.session!.grantIdFor(oidc.client!.clientId);

      if (grantId) {
        return ctx.oidc.provider.Grant.find(grantId);
      }

      const grant = new ctx.oidc.provider.Grant({
        accountId: oidc.session!.accountId,
        clientId: oidc.client!.clientId,
      });

      grant.addOIDCScope(scopes);
      await grant.save();
      return grant;
    },
  });

  const app = new Koa();

  app.use(mount("/assets", serve(path.resolve("provider/assets"))));

  app.use(nunjucksMiddleware({
    autoescape: true,
    noCache: process.env.NODE_ENV !== 'production',
  }));

  app.use(interactionRoutes(provider, accounts));

  // Fall through to oidc-provider for all other routes
  const providerHandler = provider.callback();
  app.use(async (ctx) => {
    await providerHandler(ctx.req, ctx.res);
    ctx.respond = false;
  });

  return app.callback();
}

/**
 * Derives the oidc-provider claims config from scope names
 */
function buildClaimsConfig(
  scopeList: string[],
  customClaims: string[],
): Record<string, string[]> {
  const claimMap: Record<string, string[]> = {
    openid: ["sub"],
    profile: ["name", ...customClaims],
    email: ["email"],
  };

  const result: Record<string, string[]> = {};
  for (const scope of scopeList) {
    if (scope in claimMap) {
      result[scope] = claimMap[scope];
    }
  }
  return result;
}

/**
 * Throws if any account uses a claim name not declared in customClaims
 */
function validateCustomClaims(
  accounts: readonly OidcAccount[],
  customClaims: string[],
): void {
  const allowed = new Set(customClaims);
  const undeclared = new Set<string>();

  for (const account of accounts) {
    for (const key of Object.keys(account.tokenClaims ?? {})) {
      if (!allowed.has(key)) undeclared.add(key);
    }
    for (const key of Object.keys(account.userinfoClaims ?? {})) {
      if (!allowed.has(key)) undeclared.add(key);
    }
  }

  if (undeclared.size > 0) {
    throw new Error(
      `Account claims contain keys not declared in customClaims: ${[...undeclared].join(", ")}`,
    );
  }
}
