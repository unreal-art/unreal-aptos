import { etherlinkTestnet } from "viem/chains"

// Define a fallback RPC URL in case the chain's default doesn't work
const ETHERLINK_FALLBACK_RPC = "https://node.ghostnet.etherlink.com"

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
  etherlinkRpcUrl:
    process.env.ETHERLINK_RPC_URL ||
    ETHERLINK_FALLBACK_RPC ||
    ETHERLINK_CHAIN.rpcUrls.default.http[0],
  etherlinkPrivateKey: process.env.ETHERLINK_PRIVATE_KEY || "",
  etherlinkBridgeAddress: process.env.ETHERLINK_BRIDGE_ADDRESS || "",
  etherlinkHtlcAddress: process.env.ETHERLINK_HTLC_ADDRESS || "",
  unrealTokenAddress: process.env.UNREAL_TOKEN_ADDRESS || "",
  etherlinkChainId: ETHERLINK_CHAIN.id,
  pollInterval: parseInt(process.env.RELAYER_POLL_INTERVAL || "60000", 10), // Default 1 minute
}

// Override Etherlink RPC URL with a specific endpoint that works reliably
const etherlinkRpcUrl = "https://128123.rpc.thirdweb.com/fba2eea246629666b6b38ea90e03fedb"

// Only update the RPC URL, preserve all other config properties
config.etherlinkRpcUrl = etherlinkRpcUrl

// Ensure contract addresses are exported from the config
export const {
  etherlinkBridgeAddress,
  etherlinkHtlcAddress,
  unrealTokenAddress
} = config
