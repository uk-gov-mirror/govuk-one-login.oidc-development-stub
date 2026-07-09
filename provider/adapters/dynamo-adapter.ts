import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { Adapter, AdapterPayload } from "oidc-provider";

/**
 * Models whose tokens/codes are tied to a grant and need revocation support.
 */
const GRANTABLE_MODELS = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "DeviceCode",
  "BackchannelAuthenticationRequest",
]);

export interface DynamoAdapterConfig {
  /** DynamoDB table name. */
  tableName: string;
  /** Optional DynamoDB client config (region, endpoint, credentials, etc.) */
  clientConfig?: DynamoDBClientConfig;
}

/**
 * DynamoDB adapter for oidc-provider. Stores all models in a single table
 * using a composite key (pk = model:id). Uses DynamoDB TTL for automatic
 * expiry cleanup.
 *
 * Designed for small deployments (~5 users) where the table stays small
 * enough that Scan operations are cheap and fast — no GSIs required.
 *
 * Table schema:
 *   pk (S)        - Partition key: "ModelName:id"
 *   payload (M)   - The oidc-provider payload object
 *   expiresAt (N) - Unix epoch seconds, used as DynamoDB TTL attribute
 *   grantId (S)   - Filterable attribute for revokeByGrantId
 *   userCode (S)  - Filterable attribute for findByUserCode
 *   uid (S)       - Filterable attribute for findByUid
 */
export class DynamoAdapter implements Adapter {
  private readonly model: string;
  private readonly tableName: string;
  private readonly client: DynamoDBDocumentClient;

  constructor(
    model: string,
    tableName: string,
    client: DynamoDBDocumentClient,
  ) {
    this.model = model;
    this.tableName = tableName;
    this.client = client;
  }

  private key(id: string): string {
    return `${this.model}:${id}`;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn: number,
  ): Promise<void> {
    const item: Record<string, unknown> = {
      pk: this.key(id),
      payload,
    };

    if (expiresIn) {
      item.expiresAt = this.now() + expiresIn;
    }

    if (payload.grantId && GRANTABLE_MODELS.has(this.model)) {
      item.grantId = payload.grantId;
    }
    if (payload.userCode) {
      item.userCode = payload.userCode;
    }
    if (payload.uid) {
      item.uid = payload.uid;
    }

    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: item }),
    );
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.key(id) },
      }),
    );

    if (!result.Item) return undefined;
    return this.validateExpiry(result.Item);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.scanForAttribute("uid", uid);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.scanForAttribute("userCode", userCode);
  }

  async consume(id: string): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: this.key(id) },
        UpdateExpression: "SET payload.consumed = :now",
        ExpressionAttributeValues: { ":now": this.now() },
      }),
    );
  }

  async destroy(id: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: this.key(id) },
      }),
    );
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    const result = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "grantId = :grantId",
        ExpressionAttributeValues: { ":grantId": grantId },
        ProjectionExpression: "pk",
      }),
    );

    const items = result.Items ?? [];
    await Promise.all(
      items.map((item) =>
        this.client.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: { pk: item.pk as string },
          }),
        ),
      ),
    );
  }

  private async scanForAttribute(
    attributeName: string,
    value: string,
  ): Promise<AdapterPayload | undefined> {
    const result = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: `#attr = :value`,
        ExpressionAttributeNames: { "#attr": attributeName },
        ExpressionAttributeValues: { ":value": value },
      }),
    );

    const item = result.Items?.[0];
    if (!item) return undefined;
    return this.validateExpiry(item);
  }

  /**
   * Returns the payload if the item hasn't expired, undefined otherwise.
   * DynamoDB TTL deletion is eventually consistent, so we double-check here.
   */
  private validateExpiry(
    item: Record<string, unknown>,
  ): AdapterPayload | undefined {
    const expiresAt = item.expiresAt as number | undefined;
    if (expiresAt && expiresAt < this.now()) {
      return undefined;
    }
    return item.payload as AdapterPayload;
  }
}

/**
 * Creates an AdapterConstructor-compatible class bound to a specific
 * DynamoDB table and client instance.
 */
export function createDynamoAdapterClass(
  config: DynamoAdapterConfig,
): new (model: string) => Adapter {
  const rawClient = new DynamoDBClient(config.clientConfig ?? {});
  const client = DynamoDBDocumentClient.from(rawClient, {
    marshallOptions: { removeUndefinedValues: true },
  });

  return class BoundDynamoAdapter extends DynamoAdapter {
    constructor(model: string) {
      super(model, config.tableName, client);
    }
  };
}
