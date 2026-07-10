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

      const accountOptions = [
        {
          value: "",
          text: "N/A",
          selected: true
        },
        ...accounts.map((account) => ({
          value: account.sub,
          text: account.email
        })),
      ];

      await ctx.render("auth.njk", {
        interactionUid: details.uid,
        accountOptions,
      });

      return;
    }

    // POST /interaction/:uid/login — complete the login
    const loginMatch = path.match(/^\/interaction\/([^/]+)\/login$/);
    if (loginMatch && method === "POST") {
      const body = await parseUrlEncodedBody(ctx.req);
      const accountId = body.get("account");

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

    // POST /interaction/:uid/error — complete with an error
    const errorMatch = path.match(/^\/interaction\/([^/]+)\/error$/);
    if (errorMatch && method === "POST") {
      const body = await parseUrlEncodedBody(ctx.req);

      // TODO: handle errors issued at token exchange or userinfo
      if (body.get("errorWhere") !== "authorize") {
        throw new Error("Cannot return errors on token exchange or userinfo yet");
      }

      await provider.interactionFinished(ctx.req, ctx.res, {
        error: body.get("error"),
        error_description: body.get("error_description"),
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
