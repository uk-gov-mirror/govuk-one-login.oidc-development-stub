/**
 * Module entrypoint for the stubs as an npm module.
 */

export {
  createOidcConsumer,
  type OidcConsumerConfig,
} from "./consumer/create-consumer.js";

export {
  createOidcProvider,
  type OidcProviderConfig,
  type OidcAccount,
  type OidcClient,
  type AdapterConfig,
  type NodeHandler,
} from "./provider/create-provider.js";
