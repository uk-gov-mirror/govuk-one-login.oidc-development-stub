import type { AdapterConstructor } from "oidc-provider";
import { MemoryAdapter } from "./memory-adapter.js";
import {
  createDynamoAdapterClass,
  type DynamoAdapterConfig,
} from "./dynamo-adapter.js";

export type AdapterConfig =
  { type: "memory" } | ({ type: "dynamodb" } & DynamoAdapterConfig);

/**
 * Returns an AdapterConstructor based on the provided config.
 * Defaults to in-memory when no config is given.
 */
export function resolveAdapter(
  config: AdapterConfig = { type: "memory" },
): AdapterConstructor {
  switch (config.type) {
    case "memory":
      return MemoryAdapter;
    case "dynamodb":
      return createDynamoAdapterClass(config);
  }
}

export { MemoryAdapter, clearMemoryStore } from "./memory-adapter.js";
export { DynamoAdapter, createDynamoAdapterClass } from "./dynamo-adapter.js";
export type { DynamoAdapterConfig } from "./dynamo-adapter.js";
