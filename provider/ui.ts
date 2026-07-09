import type { IncomingMessage } from "node:http";
import type Provider from "oidc-provider";
import type { OidcAccount } from "./create-provider.js";
import type Koa from "koa";

/**
 * Koa middleware handling the account picker interaction.
 */
export function interactionRoutes(
  provider: Provider,
  accounts: readonly OidcAccount[],
): Koa.Middleware {
  return async (ctx, next) => {
    const { path, method } = ctx;

    // GET /interaction/:uid — show account picker
    const getMatch = path.match(/^\/interaction\/([^/]+)$/);
    if (getMatch && method === "GET") {
      const details = await provider.interactionDetails(ctx.req, ctx.res);
      const { prompt, session } = details;

      // Already authenticated — skip the picker
      if (prompt.name === "consent" || (session && session.accountId)) {
        const accountId = session?.accountId ?? "";
        await provider.interactionFinished(ctx.req, ctx.res, {
          login: { accountId },
        });
        ctx.respond = false;
        return;
      }

      const buttons = accounts
        .map(
          (a) =>
            `<button type="submit" name="accountId" value="${a.sub}">${a.name} (${a.email})</button>`,
        )
        .join("\n        ");

      ctx.type = "text/html";
      ctx.body = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Pick an Account</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 400px; margin: 80px auto; }
  button { display: block; width: 100%; padding: 12px; margin: 8px 0; font-size: 16px; cursor: pointer; }
</style>
</head>
<body>
  <h1>Pick an Account</h1>
  <form method="POST" action="/interaction/${details.uid}/login">
    ${buttons}
  </form>
</body>
</html>`;
      return;
    }

    // POST /interaction/:uid/login — complete the login
    const postMatch = path.match(/^\/interaction\/([^/]+)\/login$/);
    if (postMatch && method === "POST") {
      const body = await parseUrlEncodedBody(ctx.req);
      const accountId = body.get("accountId");

      if (!accountId) {
        ctx.status = 400;
        ctx.body = "Missing accountId";
        return;
      }

      await provider.interactionFinished(ctx.req, ctx.res, {
        login: { accountId },
      });
      ctx.respond = false;
      return;
    }

    await next();
  };
}

/**
 * Parses a URL-encoded request body into a URLSearchParams
 */
function parseUrlEncodedBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(new URLSearchParams(Buffer.concat(chunks).toString()));
    });
    req.on("error", reject);
  });
}
