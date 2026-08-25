import Koa from "koa";
import { createOidcProvider } from "./provider/create-provider.js";
import { createOidcConsumer } from "./consumer/create-consumer.js";
import { ClientMetadata } from "oidc-provider";

const PORT = 9000;
const BASE_URL = `http://localhost:${PORT}`;
const CONSUMER_PREFIX = "/consumer";

const client: ClientMetadata =     
  {
    client_id: "consumer",
    client_secret: "consumer-secret",
    redirect_uris: [`${BASE_URL}${CONSUMER_PREFIX}/callback`],
    post_logout_redirect_uris: [`${BASE_URL}${CONSUMER_PREFIX}/`],
  }
const provider = createOidcProvider({
  issuer: BASE_URL,
  accounts: [
    {
      sub: "alice-001",
      name: "Alice Smith",
      email: "alice@example.com",
      tokenClaims: { role: "admin", department: "engineering" },
      userinfoClaims: { phone: "+1-555-0101", address: "123 Main St" },
    },
    {
      sub: "bob-001",
      name: "Bob Jones",
      email: "bob@example.com",
      userinfoClaims: { phone: "+1-555-0102", address: "456 Oak Ave" },
    },
    {
      sub: "charlie-001",
      name: "Charlie Brown",
      email: "charlie@example.com",
      tokenClaims: { role: "editor", department: "design" },
    },
  ],
  customClaims: ["role", "department", "phone", "address"],
  clients: [client],
});

const consumer = createOidcConsumer({
  provider_url: BASE_URL,
  ...client
});

// Imposter version - currently broken
// https://github.com/imposter-project/imposter-go/pull/86
// const consumer = createOidcConsumer({
//   providerUrl: 'http://localhost:8080/oidc/',
//   clientId: "webapp",
//   clientSecret: "webapp",
//   redirectUri: `${BASE_URL}${CONSUMER_PREFIX}/callback`,
// });

const app = new Koa();

app.use(async (ctx) => {
  const { path, url } = ctx;

  // Redirect root to the consumer UI
  if (path === "/") {
    ctx.redirect(`${CONSUMER_PREFIX}/`);
    return;
  }

  // Redirect /consumer → /consumer/ so relative links resolve correctly
  if (path === CONSUMER_PREFIX) {
    ctx.redirect(`${CONSUMER_PREFIX}/`);
    return;
  }

  // Strip prefix and delegate to consumer handler
  if (path.startsWith(`${CONSUMER_PREFIX}/`)) {
    ctx.req.url = url.slice(CONSUMER_PREFIX.length);
    await consumer(ctx.req, ctx.res);
    ctx.respond = false;
    return;
  }

  // Everything else goes to the provider
  await provider(ctx.req, ctx.res);
  ctx.respond = false;
});

app.listen(PORT, () => {
  console.log(`OIDC Provider: ${BASE_URL}`);
  console.log(`OIDC Consumer: ${BASE_URL}${CONSUMER_PREFIX}`);
});
