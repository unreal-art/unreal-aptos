import { AptosClient, AptosAccount, CoinClient, Types } from "aptos"
import { ethers } from "ethers"
import * as dotenv from "dotenv"
import * as fs from "fs"
import * as path from "path"
import { config } from "../config"
import { executeOnEvm } from "./etherlink_bridge"

// Load environment variables
dotenv.config()

// Initialize Aptos client
const aptosClient = new AptosClient(config.aptosNodeUrl)
const coinClient = new CoinClient(aptosClient)

// Initialize Etherlink provider and signer
const etherlinkProvider = new ethers.providers.JsonRpcProvider(
  config.etherlinkRpcUrl
)
const etherlinkWallet = new ethers.Wallet(
  config.etherlinkPrivateKey,
  etherlinkProvider
)

// Load contract ABIs
const htlcArtifact = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../../artifacts/contracts/UnrealHTLC.sol/UnrealHTLC.json"
    ),
    "utf8"
  )
)
const tokenArtifact = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../../artifacts/contracts/UnrealToken.sol/UnrealToken.json"
    ),
    "utf8"
  )
)

// Extract ABIs from artifacts
const htlcAbi = htlcArtifact.abi
const tokenAbi = tokenArtifact.abi

// Contract instances
const htlcContract = new ethers.Contract(
  config.etherlinkHtlcAddress,
  htlcAbi,
  etherlinkWallet
)
const tokenContract = new ethers.Contract(
  config.unrealTokenAddress,
  tokenAbi,
  etherlinkWallet
)

// Define the offchain order structure
interface OffchainOrder {
  maker: string // Address of the maker (user)
  sourceChainId: number // Source chain ID
  targetChainId: number // Target chain ID
  sourceToken: string // Source token address
  targetToken: string // Target token address
  amount: string // Amount to swap
  minReturn: string // Minimum amount to receive after swap
  receiver: string // Address to receive swapped tokens
  deadline: number // Order deadline timestamp
  nonce: string // Unique nonce to prevent replay attacks
  startPrice: string // Starting price for Dutch auction
  endPrice: string // Ending price for Dutch auction
  startTime: number // Auction start timestamp
  endTime: number // Auction end timestamp
  signature: string // EIP-712 signature
}

// EIP-712 domain and types for structured data signing
const EIP712_DOMAIN = {
  name: "UnrealFusion",
  version: "1",
  chainId: config.etherlinkChainId, // Use the chain ID from config
  verifyingContract: config.etherlinkHtlcAddress,
}

// EIP-712 types for order signing
const EIP712_TYPES = {
  Order: [
    { name: "maker", type: "address" },
    { name: "sourceChainId", type: "uint256" },
    { name: "targetChainId", type: "uint256" },
    { name: "sourceToken", type: "address" },
    { name: "targetToken", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "minReturn", type: "uint256" },
    { name: "receiver", type: "address" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "startPrice", type: "uint256" },
    { name: "endPrice", type: "uint256" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
  ],
}

/**
 * Create and sign an offchain order for cross-chain swap
 * @param wallet Ethers wallet to sign the order
 * @param sourceChainId Source chain ID
 * @param targetChainId Target chain ID
 * @param sourceToken Source token address
 * @param targetToken Target token address
 * @param amount Amount to swap
 * @param minReturn Minimum return amount
 * @param receiver Receiver address
 * @param deadline Order deadline
 * @param startPrice Start price for Dutch auction
 * @param endPrice End price for Dutch auction
 * @param duration Auction duration in seconds
 * @returns Signed offchain order
 */
async function createSignedOrder(
  wallet: ethers.Wallet,
  sourceChainId: number,
  targetChainId: number,
  sourceToken: string,
  targetToken: string,
  amount: string,
  minReturn: string,
  receiver: string,
  deadline: number,
  startPrice: string,
  endPrice: string,
  duration: number
): Promise<OffchainOrder> {
  // Generate a random nonce
  const nonce = ethers.BigNumber.from(ethers.utils.randomBytes(32)).toString()

  // Calculate auction times
  const startTime = Math.floor(Date.now() / 1000)
  const endTime = startTime + duration

  // Create the order object for signing
  const orderData = {
    maker: await wallet.getAddress(),
    sourceChainId,
    targetChainId,
    sourceToken,
    targetToken,
    amount: ethers.utils.parseEther(amount).toString(),
    minReturn: ethers.utils.parseEther(minReturn).toString(),
    receiver,
    deadline,
    nonce,
    startPrice: ethers.utils.parseEther(startPrice).toString(),
    endPrice: ethers.utils.parseEther(endPrice).toString(),
    startTime,
    endTime,
  }

  // Sign the order using EIP-712
  const signature = await wallet._signTypedData(
    EIP712_DOMAIN,
    EIP712_TYPES,
    orderData
  )

  // Return the full order with signature
  return {
    ...orderData,
    signature,
  }
}

/**
 * Verify an order signature
 * @param order Order to verify
 * @returns Boolean indicating if signature is valid
 */
function verifyOrderSignature(order: OffchainOrder): boolean {
  try {
    // Extract the order data without the signature
    const { signature, ...orderData } = order

    // Recover the signer address
    const recoveredAddress = ethers.utils.verifyTypedData(
      EIP712_DOMAIN,
      EIP712_TYPES,
      orderData,
      signature
    )

    // Compare with the maker address
    return recoveredAddress.toLowerCase() === order.maker.toLowerCase()
  } catch (error) {
    console.error("Error verifying signature:", error)
    return false
  }
}

/**
 * Calculate current Dutch auction price
 * @param order The order with auction parameters
 * @returns Current price
 */
function calculateCurrentPrice(order: OffchainOrder): string {
  const now = Math.floor(Date.now() / 1000)

  // If auction hasn't started yet, return start price
  if (now < order.startTime) {
    return order.startPrice
  }

  // If auction has ended, return end price
  if (now >= order.endTime) {
    return order.endPrice
  }

  // Calculate price based on linear interpolation
  const startPrice = ethers.BigNumber.from(order.startPrice)
  const endPrice = ethers.BigNumber.from(order.endPrice)
  const elapsed = now - order.startTime
  const duration = order.endTime - order.startTime
  const progress = elapsed / duration

  // Linear interpolation: startPrice - (startPrice - endPrice) * progress
  const priceDiff = startPrice.sub(endPrice)
  const priceReduction = priceDiff.mul(Math.floor(progress * 10000)).div(10000)
  const currentPrice = startPrice.sub(priceReduction)

  return currentPrice.toString()
}

/**
 * Solver function to execute a cross-chain swap based on an order
 * @param order The signed order to execute
 * @param solverWallet The solver's wallet
 */
async function executeOrderAsSolver(
  order: OffchainOrder,
  solverWallet: ethers.Wallet
): Promise<void> {
  try {
    console.log(`Executing order as solver...`)

    // Verify order signature
    if (!verifyOrderSignature(order)) {
      throw new Error("Invalid order signature")
    }

    // Check if order is expired
    const now = Math.floor(Date.now() / 1000)
    if (now > order.deadline) {
      throw new Error("Order expired")
    }

    // Calculate current auction price
    const currentPrice = calculateCurrentPrice(order)
    console.log(
      `Current auction price: ${ethers.utils.formatEther(currentPrice)} ETH`
    )

    // Determine if this is an Etherlink to Aptos or Aptos to Etherlink swap
    if (order.sourceChainId === config.etherlinkChainId) {
      // Etherlink to Aptos swap
      await executeEtherlinkToAptosSwap(order, solverWallet, currentPrice)
    } else if (order.targetChainId === config.etherlinkChainId) {
      // Aptos to Etherlink swap
      await executeAptosToEtherlinkSwap(order, solverWallet, currentPrice)
    } else {
      throw new Error("Unsupported chain combination")
    }
  } catch (error) {
    console.error("Error executing order:", error)
  }
}

/**
 * Execute Etherlink to Aptos swap
 * @param order The order to execute
 * @param solverWallet Solver's wallet
 * @param feeAmount Fee amount for the solver
 */
async function executeEtherlinkToAptosSwap(
  order: OffchainOrder,
  solverWallet: ethers.Wallet,
  feeAmount: string
): Promise<void> {
  console.log(`Executing Etherlink -> Aptos swap...`)

  try {
    // Connect to contracts with solver wallet
    const solverHtlc = htlcContract.connect(solverWallet)
    const solverToken = tokenContract.connect(solverWallet)

    // Generate a secret hash for the HTLC
    const secret = ethers.utils.randomBytes(32)
    const secretHash = ethers.utils.keccak256(secret)
    console.log(`Generated secret: ${ethers.utils.hexlify(secret)}`)
    console.log(`Secret hash: ${secretHash}`)

    // Approve tokens for HTLC
    console.log(`Approving token transfer...`)
    const approveTx = await solverToken.approve(
      config.etherlinkHtlcAddress,
      order.amount
    )
    await approveTx.wait()
    console.log(`Approval transaction: ${approveTx.hash}`)

    // Lock funds in HTLC using initiateSwap function
    console.log(`Locking funds in HTLC...`)

    // Derive EVM compatible address from Aptos address
    // For the receiver, we'll use the address as is since it's already in EVM format for testing
    const evmCompatibleAddress = order.receiver

    const lockTx = await solverHtlc.initiateSwap(
      secretHash,
      evmCompatibleAddress,
      order.amount,
      order.deadline,
      "Aptos", // Target chain identifier
      order.receiver // Original receiver address as string in target chain data
    )
    await lockTx.wait()
    console.log(`Lock transaction: ${lockTx.hash}`)

    // Extract swap ID from the transaction receipt events
    const receipt = await lockTx.wait()

    // Find the SwapInitiated event
    const swapInitiatedEvent = receipt.events?.find(
      (e: any) => e.event === "SwapInitiated"
    )
    const swapId = swapInitiatedEvent?.args?.swapId
    console.log(`Swap ID: ${swapId}`)

    // Now initiate the corresponding swap on Aptos side
    // This is simplified and would need to be implemented based on your Aptos module
    console.log(`Now solver needs to:
1. Initiate the corresponding swap on Aptos
2. Pay ${ethers.utils.formatEther(feeAmount)} ETH to cover costs
3. Wait for the user to claim on Aptos using the secret: ${ethers.utils.hexlify(secret)}`)

    // Store the swap details for the solver to track
    const swapDetails = {
      swapId,
      secret: ethers.utils.hexlify(secret),
      secretHash,
      sourceChain: "Etherlink",
      targetChain: "Aptos",
      amount: order.amount,
      deadline: order.deadline,
      maker: order.maker,
      receiver: order.receiver,
      fee: feeAmount,
    }

    console.log(`Swap details:`, JSON.stringify(swapDetails, null, 2))

    // Save swap details to file for the solver
    fs.writeFileSync(
      `swap_${swapId}.json`,
      JSON.stringify(swapDetails, null, 2)
    )
  } catch (error) {
    console.error(`Error executing Etherlink to Aptos swap:`, error)
  }
}

/**
 * Execute Aptos to Etherlink swap
 * @param order The order to execute
 * @param solverWallet Solver's wallet
 * @param feeAmount Fee amount for the solver
 */
async function executeAptosToEtherlinkSwap(
  order: OffchainOrder,
  solverWallet: ethers.Wallet,
  feeAmount: string
): Promise<void> {
  console.log(`Executing Aptos -> Etherlink swap...`)

  try {
    // For Aptos to Etherlink, solver would:
    // 1. Create an HTLC on Aptos side
    // 2. Wait for the user to reveal the secret on Etherlink side
    // 3. Collect the funds on Aptos side using the revealed secret

    // Generate a secret hash for the HTLC
    const secret = ethers.utils.randomBytes(32)
    const secretHash = ethers.utils.keccak256(secret)
    console.log(`Generated secret: ${ethers.utils.hexlify(secret)}`)
    console.log(`Secret hash: ${secretHash}`)

    // This would involve interacting with the Aptos module to create an HTLC
    // The exact implementation depends on your Aptos module structure
    console.log(`Now solver needs to:
1. Create HTLC on Aptos side with secret hash: ${secretHash}
2. Pay ${ethers.utils.formatEther(feeAmount)} ETH to cover costs
3. Wait for the user to claim on Etherlink using the secret: ${ethers.utils.hexlify(secret)}`)

    // Store the swap details for the solver to track
    const swapDetails = {
      secretHash,
      secret: ethers.utils.hexlify(secret),
      sourceChain: "Aptos",
      targetChain: "Etherlink",
      amount: order.amount,
      deadline: order.deadline,
      maker: order.maker,
      receiver: order.receiver,
      fee: feeAmount,
    }

    console.log(`Swap details:`, JSON.stringify(swapDetails, null, 2))

    // Save swap details to file for the solver
    fs.writeFileSync(
      `swap_${ethers.utils.id(secretHash + order.maker)}.json`,
      JSON.stringify(swapDetails, null, 2)
    )
  } catch (error) {
    console.error(`Error executing Aptos to Etherlink swap:`, error)
  }
}

/**
 * Solver monitoring function to watch for new orders and execute them
 * @param solverWallet The solver's wallet
 * @param ordersFile Path to the JSON file containing orders
 * @param monitorInterval Interval in milliseconds to check for new orders
 */
async function startSolverMonitor(
  solverWallet: ethers.Wallet,
  ordersFile: string,
  monitorInterval: number = 30000
): Promise<void> {
  console.log(`Starting solver monitor...`)
  console.log(`Solver address: ${await solverWallet.getAddress()}`)
  console.log(`Orders file: ${ordersFile}`)

  // Keep track of already processed orders
  const processedOrders = new Set<string>()

  // Monitor function
  const monitor = async () => {
    try {
      // Check if orders file exists
      if (!fs.existsSync(ordersFile)) {
        console.log(`No orders file found. Waiting for orders...`)
        return
      }

      // Read orders from file
      const ordersData = JSON.parse(fs.readFileSync(ordersFile, "utf8"))
      const orders: OffchainOrder[] = ordersData.orders || []

      // Process new orders
      for (const order of orders) {
        // Skip already processed orders
        const orderKey = `${order.maker}-${order.nonce}`
        if (processedOrders.has(orderKey)) continue

        // Check if order is valid and not expired
        const now = Math.floor(Date.now() / 1000)
        if (now > order.deadline) continue

        console.log(`Found new order from ${order.maker}`)

        // Execute the order
        await executeOrderAsSolver(order, solverWallet)

        // Mark order as processed
        processedOrders.add(orderKey)
      }
    } catch (error) {
      console.error(`Error in solver monitor:`, error)
    }
  }

  // Initial run
  await monitor()

  // Set up interval
  const intervalId = setInterval(monitor, monitorInterval)
  console.log(
    `Solver monitor started. Checking every ${monitorInterval / 1000} seconds.`
  )

  // Prevent the Node.js process from exiting
  process.stdin.resume()

  // Handle process termination gracefully
  process.on("SIGINT", () => {
    console.log("\nSolver monitor stopping...")
    clearInterval(intervalId)
    console.log("Solver monitor stopped. Exiting.")
    process.exit(0)
  })

  // Log to show the monitor is still running
  setInterval(() => {
    console.log(`Solver monitor still active at ${new Date().toISOString()}`)
  }, 300000) // Log every 5 minutes
}

/**
 * Generate a JSON file with signed order for testing
 * @param wallet User wallet to sign the order
 * @param outputFile Output file path
 */
async function generateTestOrder(
  wallet: ethers.Wallet,
  outputFile: string
): Promise<void> {
  console.log(`Generating test order...`)

  // Create a signed order
  const order = await createSignedOrder(
    wallet,
    config.etherlinkChainId, // Source chain ID (Etherlink)
    420, // Target chain ID (Aptos - using a placeholder ID)
    config.unrealTokenAddress, // Source token (Unreal token)
    "0x0000000000000000000000000000000000000000", // Target token (placeholder for Aptos)
    "1.0", // Amount: 1 UNREAL
    "0.95", // Min return: 0.95 UNREAL (5% slippage)
    "0x0000000000000000000000000000000000000001", // Receiver (placeholder Aptos address)
    Math.floor(Date.now() / 1000) + 3600, // Deadline: 1 hour from now
    "0.01", // Start price: 0.01 ETH
    "0.005", // End price: 0.005 ETH
    600 // Duration: 10 minutes
  )

  // Save order to file
  const ordersData = {
    orders: [order],
  }

  fs.writeFileSync(outputFile, JSON.stringify(ordersData, null, 2))
  console.log(`Test order saved to ${outputFile}`)
  console.log(`Order details:`, JSON.stringify(order, null, 2))
}

// Command line interface
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === "create-order") {
    // Check if we have required args
    if (args.length < 3) {
      console.log(
        "Usage: npm run fusion-cross-chain create-order <private_key> <output_file>"
      )
      process.exit(1)
    }

    const privateKey = args[1]
    const outputFile = args[2]
    const wallet = new ethers.Wallet(privateKey, etherlinkProvider)

    await generateTestOrder(wallet, outputFile)
  } else if (command === "start-solver") {
    // Check if we have required args
    if (args.length < 3) {
      console.log(
        "Usage: npm run fusion-cross-chain start-solver <private_key> <orders_file>"
      )
      process.exit(1)
    }

    const privateKey = args[1]
    const ordersFile = args[2]
    const wallet = new ethers.Wallet(privateKey, etherlinkProvider)

    await startSolverMonitor(wallet, ordersFile)
  } else {
    console.log(`
Unreal Cross-Chain Fusion CLI

Available commands:
  create-order <private_key> <output_file> - Create and sign a test order
  start-solver <private_key> <orders_file> - Start a solver to execute orders
`)
  }
}

// Run the CLI
if (require.main === module) {
  main()
  Bun.sleep(1000 * 1e3)
}

export {
  OffchainOrder,
  createSignedOrder,
  verifyOrderSignature,
  calculateCurrentPrice,
  executeOrderAsSolver,
  startSolverMonitor,
}
