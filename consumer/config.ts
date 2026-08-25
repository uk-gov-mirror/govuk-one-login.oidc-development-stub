import { readFile } from "fs/promises";
import { OidcConsumerConfig } from "./create-consumer.js";
import { SecretsManagerClient , GetSecretValueCommand} from "@aws-sdk/client-secrets-manager";

export const fetchConfiguration = async (): Promise<OidcConsumerConfig> => {
    if (!process.env.ENVIRONMENT || process.env.ENVIRONMENT === "local"){
        const data = await readFile("config.local.json", "utf8");
        return (JSON.parse(data) as OidcConsumerConfig);
    } else {
        const ssmClient = new SecretsManagerClient({region: "eu-west-2"});
        const config = (await ssmClient.send(new GetSecretValueCommand({
            SecretId: `${process.env.ENVIRONMENT}-stub-client-config`
        }))).SecretString
        if (!config){
            throw new Error(`Could not find secret with id ${process.env.ENVIRONMENT}-stub-client-config`)
        }
        return (JSON.parse(config) as OidcConsumerConfig);
    }
}