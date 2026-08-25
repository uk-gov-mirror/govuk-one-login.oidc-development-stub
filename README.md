# OIDC Development Stub

> **Important** - This is currently in active development, and even when its done, this is **not** intended for production workflows.

Tooling for creating an OIDC stub service for development. Currently a work in progress, but there's two things here:

- An npm module (not currently published) at [`index.ts`](./index.ts), which exposes HTTP middleware for a development OIDC provider, and consumer.
- An example server with both of them bundled together, in [`app.ts`](./app.ts), which is also packaged for Docker.

## Quick Start

```bash
npm i
npm start
```

Or with Docker:

```bash
docker compose up
```

This starts a server on http://localhost:9001. Visiting the root redirects to the consumer UI.

- **Consumer** — http://localhost:9001/consumer/ (relying party that displays token claims)
- **Provider** — http://localhost:9001 (OIDC identity provider, serves discovery + auth endpoints)

Click "Login with OIDC" on the consumer page to run the full authorization code + PKCE flow.

## Architecture

A Koa app in `app.ts` routes by path prefix:

- `/consumer/` — delegated to `createOidcConsumer`, an `openid-client` v6 relying party with PKCE
- Everything else — delegated to `createOidcProvider`, an `oidc-provider` instance with an account picker interaction

Both modules export a `NodeHandler` factory that returns a `(req, res) => Promise<void>` handler.

## Client Configuration

The consumer is pre-registered with the provider:

- **Client ID:** `consumer`
- **Client Secret:** `consumer-secret`
- **Redirect URI:** `http://localhost:9001/consumer/callback`
- **Scopes:** `openid profile email`

This config is stored locally in `config.local.json`. There is an example configuration in the repo called `config.template.json`. You need to copy and rename this file in order to run the app locally.

When run in a deployed state, it will look for the secret `${process.env.ENVIRONMENT}-stub-client-config` and import the config from that secret

## Adapter Configuration

By default the provider uses an in-memory store (state is lost on restart). For Lambda or multi-instance deployments, use the DynamoDB adapter:

```typescript
createOidcProvider({
  issuer: "https://auth.example.com",
  accounts,
  clients,
  adapter: {
    type: "dynamodb",
    tableName: "oidc-sessions",
    clientConfig: { region: "eu-west-1" },
  },
});
```

### DynamoDB Table (CloudFormation)

When running this in a Lambda, storing state in-memory will cause issues every time the service restarts. For that reason, there's a DynamoDB store provided - setup is pretty minimal. The simplified setup does full table scans, rather than adding GSIs, so won't scale to high numbers of users.

```yaml
OidcSessionsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: oidc-sessions
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: pk
        AttributeType: S
    KeySchema:
      - AttributeName: pk
        KeyType: HASH
    TimeToLiveSpecification:
      AttributeName: expiresAt
      Enabled: true
```
