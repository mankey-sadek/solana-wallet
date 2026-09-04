import { Connection } from "@solana/web3.js";
import { config } from "../config";

export function createConnection(): Connection {
  return new Connection(config.rpcHttpUrl, {
    commitment: "confirmed",
    wsEndpoint: config.rpcWsUrl,
  });
}
