import { 
  AptosClient, 
  AptosAccount, 
  FaucetClient, 
  TokenClient,
  CoinClient,
  Types 
} from 'aptos';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

// Configuration
const config = {
  aptosNodeUrl: process.env.APTOS_NODE_URL || 'https://fullnode.testnet.aptoslabs.com',
  aptosPrivateKey: process.env.APTOS_PRIVATE_KEY || '',
  aptosModuleAddress: process.env.APTOS_MODULE_ADDRESS || '0x1',
  aptosModuleName: process.env.APTOS_MODULE_NAME || 'unreal',
  etherlinkRpcUrl: process.env.ETHERLINK_RPC_URL || 'http://localhost:8545',
  etherlinkPrivateKey: process.env.ETHERLINK_PRIVATE_KEY || '',
  etherlinkBridgeAddress: process.env.ETHERLINK_BRIDGE_ADDRESS || '',
  unrealTokenAddress: process.env.UNREAL_TOKEN_ADDRESS || '',
};

// Initialize Aptos client
const aptosClient = new AptosClient(config.aptosNodeUrl);
const coinClient = new CoinClient(aptosClient);
const tokenClient = new TokenClient(aptosClient);

// Initialize Etherlink provider and signer
const etherlinkProvider = new ethers.providers.JsonRpcProvider(config.etherlinkRpcUrl);
const etherlinkWallet = new ethers.Wallet(config.etherlinkPrivateKey, etherlinkProvider);

// Load bridge ABI
const bridgeAbi = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../contracts/abi/UnrealBridge.json'),
  'utf8'
));
const tokenAbi = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../contracts/abi/UnrealToken.json'),
  'utf8'
));

// Contract instances
const bridgeContract = new ethers.Contract(
  config.etherlinkBridgeAddress, 
  bridgeAbi, 
  etherlinkWallet
);
const tokenContract = new ethers.Contract(
  config.unrealTokenAddress,
  tokenAbi,
  etherlinkWallet
);

// Aptos account from private key
const aptosAccount = new AptosAccount(
  Buffer.from(config.aptosPrivateKey.replace(/^0x/, ''), 'hex')
);

/**
 * Generate a random secret for HTLC
 * @returns {Object} secret and hash
 */
function generateSecret(): { secret: string, hash: string } {
  const secret = crypto.randomBytes(32).toString('hex');
  const hash = ethers.utils.keccak256('0x' + secret);
  return { secret, hash };
}

/**
 * Convert ethereum address to hex string without 0x prefix
 * @param address Ethereum address
 * @returns Hex string without 0x prefix
 */
function ethAddressToHex(address: string): string {
  return address.substring(2).toLowerCase();
}

/**
 * Initiate a swap from Etherlink to Aptos
 * @param amount Amount to swap
 * @param receiverAddress Aptos address to receive tokens
 */
async function initiateEtherlinkToAptosSwap(
  amount: string,
  receiverAddress: string
): Promise<void> {
  try {
    console.log(`Starting Etherlink -> Aptos swap...`);
    console.log(`Amount: ${amount} UNREAL`);
    console.log(`Receiver: ${receiverAddress}`);
    
    // Generate secret and hash
    const { secret, hash } = generateSecret();
    console.log(`Generated secret: ${secret}`);
    console.log(`Secret hash: ${hash}`);
    
    // Approve token spend
    const amountWei = ethers.utils.parseEther(amount);
    console.log(`Approving token spend of ${amountWei.toString()} wei...`);
    const approveTx = await tokenContract.approve(
      config.etherlinkBridgeAddress, 
      amountWei
    );
    await approveTx.wait();
    console.log(`Approval transaction: ${approveTx.hash}`);
    
    // Lock tokens in bridge contract
    console.log(`Locking tokens in bridge contract...`);
    const tx = await bridgeContract.initiateSwap(
      hash,
      receiverAddress,
      amountWei,
      24, // 24 hours timelock
      'Aptos',
      receiverAddress // Using receiver address as target for simplicity
    );
    
    const receipt = await tx.wait();
    console.log(`Swap initiated! Transaction: ${tx.hash}`);
    
    // Extract swap ID from events
    const swapInitiatedEvent = receipt.events?.find(e => e.event === 'SwapInitiated');
    const swapId = swapInitiatedEvent?.args?.swapId;
    console.log(`Swap ID: ${swapId}`);
    
    // Save the swap details for later use
    const swapDetails = {
      swapId,
      secret,
      hash,
      amount,
      sender: etherlinkWallet.address,
      receiver: receiverAddress,
      timelock: 24,
      timestamp: Date.now(),
      status: 'initiated',
      sourceChain: 'Etherlink',
      targetChain: 'Aptos',
    };
    
    fs.writeFileSync(
      path.join(__dirname, `swap_${swapId}.json`),
      JSON.stringify(swapDetails, null, 2)
    );
    
    console.log(`Swap details saved to swap_${swapId}.json`);
    console.log(`IMPORTANT: Keep the secret safe to complete the swap on Aptos!`);
    
  } catch (error) {
    console.error(`Error initiating swap:`, error);
  }
}

/**
 * Complete a swap from Etherlink to Aptos
 * @param swapId The ID of the swap to complete
 */
async function completeEtherlinkToAptosSwap(swapId: string): Promise<void> {
  try {
    console.log(`Completing Etherlink -> Aptos swap...`);
    
    // Load swap details
    const swapDetailsPath = path.join(__dirname, `swap_${swapId}.json`);
    if (!fs.existsSync(swapDetailsPath)) {
      throw new Error(`Swap details not found for ID: ${swapId}`);
    }
    
    const swapDetails = JSON.parse(fs.readFileSync(swapDetailsPath, 'utf8'));
    console.log(`Loaded swap details for ID: ${swapId}`);
    
    // Call the Aptos contract to complete the swap
    const payload: Types.EntryFunctionPayload = {
      function: `${config.aptosModuleAddress}::${config.aptosModuleName}::complete_swap`,
      type_arguments: [],
      arguments: [
        'Etherlink', // source_chain
        swapDetails.sender, // source_address
        swapDetails.receiver, // destination
        ethers.utils.parseEther(swapDetails.amount).toString(), // amount
        swapDetails.secret, // preimage
      ],
    };
    
    // Submit transaction
    console.log(`Submitting transaction to Aptos...`);
    const tx = await aptosClient.generateTransaction(aptosAccount.address(), payload);
    const signedTx = await aptosClient.signTransaction(aptosAccount, tx);
    const pendingTx = await aptosClient.submitTransaction(signedTx);
    
    // Wait for transaction
    const txResult = await aptosClient.waitForTransaction(pendingTx.hash);
    console.log(`Aptos transaction completed!`);
    console.log(`Transaction hash: ${txResult.hash}`);
    
    // Update swap status
    swapDetails.status = 'completed';
    swapDetails.completedAt = Date.now();
    swapDetails.aptosTransactionHash = txResult.hash;
    
    fs.writeFileSync(
      swapDetailsPath,
      JSON.stringify(swapDetails, null, 2)
    );
    
    console.log(`Swap completed and details updated!`);
    
  } catch (error) {
    console.error(`Error completing swap:`, error);
  }
}

/**
 * Initiate a swap from Aptos to Etherlink
 * @param amount Amount to swap
 * @param receiverAddress Ethereum address to receive tokens
 */
async function initiateAptosToEtherlinkSwap(
  amount: string,
  receiverAddress: string
): Promise<void> {
  try {
    console.log(`Starting Aptos -> Etherlink swap...`);
    console.log(`Amount: ${amount} UNREAL`);
    console.log(`Receiver: ${receiverAddress}`);
    
    // Generate secret and hash
    const { secret, hash } = generateSecret();
    console.log(`Generated secret: ${secret}`);
    console.log(`Secret hash: ${hash}`);
    
    // Convert amount to u64
    const amountU64 = Math.floor(parseFloat(amount) * 10**8);
    
    // Create transaction payload
    const payload: Types.EntryFunctionPayload = {
      function: `${config.aptosModuleAddress}::${config.aptosModuleName}::initiate_swap`,
      type_arguments: [],
      arguments: [
        Buffer.from(hash.replace(/^0x/, ''), 'hex'), // secret_hash
        receiverAddress, // recipient
        amountU64.toString(), // amount
        '24', // timeout_hours
        'Etherlink', // target_chain
        receiverAddress, // target_address
      ],
    };
    
    // Submit transaction
    console.log(`Submitting transaction to Aptos...`);
    const tx = await aptosClient.generateTransaction(aptosAccount.address(), payload);
    const signedTx = await aptosClient.signTransaction(aptosAccount, tx);
    const pendingTx = await aptosClient.submitTransaction(signedTx);
    
    // Wait for transaction
    const txResult = await aptosClient.waitForTransaction(pendingTx.hash);
    console.log(`Swap initiated! Transaction: ${txResult.hash}`);
    
    // Generate swap ID based on parameters similar to contract
    const swapId = crypto.createHash('sha256')
      .update(Buffer.concat([
        Buffer.from(hash.replace(/^0x/, ''), 'hex'),
        Buffer.from(receiverAddress),
        Buffer.from(aptosAccount.address().toString()),
        Buffer.from(amountU64.toString()),
        Buffer.from(Date.now().toString()),
      ]))
      .digest('hex');
    
    // Save the swap details for later use
    const swapDetails = {
      swapId,
      secret,
      hash,
      amount,
      sender: aptosAccount.address().toString(),
      receiver: receiverAddress,
      timelock: 24,
      timestamp: Date.now(),
      status: 'initiated',
      sourceChain: 'Aptos',
      targetChain: 'Etherlink',
      aptosTransactionHash: txResult.hash,
    };
    
    fs.writeFileSync(
      path.join(__dirname, `swap_${swapId}.json`),
      JSON.stringify(swapDetails, null, 2)
    );
    
    console.log(`Swap details saved to swap_${swapId}.json`);
    console.log(`IMPORTANT: Keep the secret safe to complete the swap on Etherlink!`);
    
  } catch (error) {
    console.error(`Error initiating swap:`, error);
  }
}

/**
 * Complete a swap from Aptos to Etherlink
 * @param swapId The ID of the swap to complete
 */
async function completeAptosToEtherlinkSwap(swapId: string): Promise<void> {
  try {
    console.log(`Completing Aptos -> Etherlink swap...`);
    
    // Load swap details
    const swapDetailsPath = path.join(__dirname, `swap_${swapId}.json`);
    if (!fs.existsSync(swapDetailsPath)) {
      throw new Error(`Swap details not found for ID: ${swapId}`);
    }
    
    const swapDetails = JSON.parse(fs.readFileSync(swapDetailsPath, 'utf8'));
    console.log(`Loaded swap details for ID: ${swapId}`);
    
    // Call the Etherlink contract to complete the swap
    console.log(`Completing swap on Etherlink...`);
    const tx = await bridgeContract.completeSwap(
      swapDetails.sourceChain,
      swapDetails.sender,
      swapDetails.receiver,
      ethers.utils.parseEther(swapDetails.amount),
      swapDetails.secret
    );
    
    const receipt = await tx.wait();
    console.log(`Etherlink transaction completed!`);
    console.log(`Transaction hash: ${receipt.transactionHash}`);
    
    // Update swap status
    swapDetails.status = 'completed';
    swapDetails.completedAt = Date.now();
    swapDetails.etherlinkTransactionHash = receipt.transactionHash;
    
    fs.writeFileSync(
      swapDetailsPath,
      JSON.stringify(swapDetails, null, 2)
    );
    
    console.log(`Swap completed and details updated!`);
    
  } catch (error) {
    console.error(`Error completing swap:`, error);
  }
}

/**
 * Execute transaction on EVM from Aptos using 1inch Fusion
 * @param chainId EVM chain ID
 * @param contractAddress Target contract address
 * @param calldata Contract call data
 * @param gasLimit Gas limit for transaction
 */
async function executeOnEvm(
  chainId: number,
  contractAddress: string,
  calldata: string,
  gasLimit: number
): Promise<void> {
  try {
    console.log(`Executing transaction on EVM chain ${chainId}...`);
    
    // Create transaction payload
    const payload: Types.EntryFunctionPayload = {
      function: `${config.aptosModuleAddress}::${config.aptosModuleName}::execute_on_evm`,
      type_arguments: [],
      arguments: [
        chainId.toString(), // evm_chain_id
        contractAddress, // contract_address
        Buffer.from(calldata.replace(/^0x/, ''), 'hex'), // calldata
        gasLimit.toString(), // gas_limit
      ],
    };
    
    // Submit transaction
    console.log(`Submitting transaction to Aptos...`);
    const tx = await aptosClient.generateTransaction(aptosAccount.address(), payload);
    const signedTx = await aptosClient.signTransaction(aptosAccount, tx);
    const pendingTx = await aptosClient.submitTransaction(signedTx);
    
    // Wait for transaction
    const txResult = await aptosClient.waitForTransaction(pendingTx.hash);
    console.log(`Transaction submitted! Hash: ${txResult.hash}`);
    
  } catch (error) {
    console.error(`Error executing EVM transaction:`, error);
  }
}

// Command line interface
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'etherlink-to-aptos':
      if (args.length < 3) {
        console.error('Usage: etherlink-to-aptos <amount> <receiver_address>');
        process.exit(1);
      }
      await initiateEtherlinkToAptosSwap(args[1], args[2]);
      break;
      
    case 'complete-aptos':
      if (args.length < 2) {
        console.error('Usage: complete-aptos <swap_id>');
        process.exit(1);
      }
      await completeEtherlinkToAptosSwap(args[1]);
      break;
      
    case 'aptos-to-etherlink':
      if (args.length < 3) {
        console.error('Usage: aptos-to-etherlink <amount> <receiver_address>');
        process.exit(1);
      }
      await initiateAptosToEtherlinkSwap(args[1], args[2]);
      break;
      
    case 'complete-etherlink':
      if (args.length < 2) {
        console.error('Usage: complete-etherlink <swap_id>');
        process.exit(1);
      }
      await completeAptosToEtherlinkSwap(args[1]);
      break;
      
    case 'execute-evm':
      if (args.length < 5) {
        console.error('Usage: execute-evm <chain_id> <contract_address> <calldata> <gas_limit>');
        process.exit(1);
      }
      await executeOnEvm(
        parseInt(args[1], 10),
        args[2],
        args[3],
        parseInt(args[4], 10)
      );
      break;
      
    default:
      console.log(`
Unreal Cross-Chain Bridge CLI

Available commands:
  etherlink-to-aptos <amount> <receiver_address>  - Initiate swap from Etherlink to Aptos
  complete-aptos <swap_id>                       - Complete swap on Aptos side
  aptos-to-etherlink <amount> <receiver_address>  - Initiate swap from Aptos to Etherlink
  complete-etherlink <swap_id>                   - Complete swap on Etherlink side
  execute-evm <chain_id> <contract_address> <calldata> <gas_limit> - Execute EVM tx from Aptos
      `);
      break;
  }
}

// Run the CLI
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export {
  initiateEtherlinkToAptosSwap,
  completeEtherlinkToAptosSwap,
  initiateAptosToEtherlinkSwap,
  completeAptosToEtherlinkSwap,
  executeOnEvm,
};
