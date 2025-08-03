import { etherlinkTestnet } from "viem/chains"

export const ETHERLINK_CHAIN = etherlinkTestnet
export const config = {
  aptosNodeUrl:
    process.env.APTOS_NODE_URL || "https://fullnode.testnet.aptoslabs.com",
  aptosIndexerUrl:
    process.env.APTOS_INDEXER_URL ||
    "https://indexer.testnet.aptoslabs.com/v1/graphql",
  aptosPrivateKey: process.env.APTOS_PRIVATE_KEY || "",
  aptosModuleAddress: process.env.APTOS_MODULE_ADDRESS || "0x1",
  aptosModuleName: process.env.APTOS_MODULE_NAME || "unreal",
  etherlinkRpcUrl: process.env.ETHERLINK_RPC_URL || ETHERLINK_CHAIN.rpcUrls[0],
  etherlinkPrivateKey: process.env.ETHERLINK_PRIVATE_KEY || "",
  etherlinkBridgeAddress: process.env.ETHERLINK_BRIDGE_ADDRESS || "",
  etherlinkHtlcAddress: process.env.ETHERLINK_HTLC_ADDRESS || "",
  unrealTokenAddress: process.env.UNREAL_TOKEN_ADDRESS || "",
  pollInterval: parseInt(process.env.RELAYER_POLL_INTERVAL || "60000", 10), // Default 1 minute
}
