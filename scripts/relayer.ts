import { 
  AptosClient, 
  AptosAccount, 
  Types,
  IndexerClient
} from 'aptos';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {
  completeEtherlinkToAptosSwap,
  completeAptosToEtherlinkSwap
} from './etherlink_bridge';

// Load environment variables
dotenv.config();

// Configuration
const config = {
  aptosNodeUrl: process.env.APTOS_NODE_URL || 'https://fullnode.testnet.aptoslabs.com',
  aptosIndexerUrl: process.env.APTOS_INDEXER_URL || 'https://indexer.testnet.aptoslabs.com/v1/graphql',
  aptosPrivateKey: process.env.APTOS_PRIVATE_KEY || '',
  aptosModuleAddress: process.env.APTOS_MODULE_ADDRESS || '0x1',
  aptosModuleName: process.env.APTOS_MODULE_NAME || 'unreal',
  etherlinkRpcUrl: process.env.ETHERLINK_RPC_URL || 'http://localhost:8545',
  etherlinkPrivateKey: process.env.ETHERLINK_PRIVATE_KEY || '',
  etherlinkBridgeAddress: process.env.ETHERLINK_BRIDGE_ADDRESS || '',
  pollInterval: parseInt(process.env.RELAYER_POLL_INTERVAL || '60000', 10), // Default 1 minute
};

// Initialize Aptos client
const aptosClient = new AptosClient(config.aptosNodeUrl);
const indexerClient = new IndexerClient(config.aptosIndexerUrl);

// Initialize Etherlink provider and contract
const etherlinkProvider = new ethers.providers.JsonRpcProvider(config.etherlinkRpcUrl);
const etherlinkWallet = new ethers.Wallet(config.etherlinkPrivateKey, etherlinkProvider);

// Load bridge ABI
const bridgeAbi = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../contracts/abi/UnrealBridge.json'),
  'utf8'
));

// Contract instance
const bridgeContract = new ethers.Contract(
  config.etherlinkBridgeAddress,
  bridgeAbi,
  etherlinkWallet
);

// Aptos account from private key
const aptosAccount = new AptosAccount(
  Buffer.from(config.aptosPrivateKey.replace(/^0x/, ''), 'hex')
);

// Store last processed block/version
let lastEtherlinkBlock = 0;
let lastAptosVersion = 0;

// Store pending swaps
interface PendingSwap {
  id: string;
  sourceChain: string;
  destinationChain: string;
  sender: string;
  recipient: string;
  amount: string;
  secretHash: string;
  timestamp: number;
}

const pendingSwaps: Record<string, PendingSwap> = {};

/**
 * Save relayer state to disk
 */
function saveRelayerState(): void {
  const state = {
    lastEtherlinkBlock,
    lastAptosVersion,
    pendingSwaps,
  };
  
  fs.writeFileSync(
    path.join(__dirname, 'relayer_state.json'),
    JSON.stringify(state, null, 2)
  );
}

/**
 * Load relayer state from disk
 */
function loadRelayerState(): void {
  try {
    const statePath = path.join(__dirname, 'relayer_state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      lastEtherlinkBlock = state.lastEtherlinkBlock || 0;
      lastAptosVersion = state.lastAptosVersion || 0;
      
      // Load pending swaps
      Object.assign(pendingSwaps, state.pendingSwaps || {});
      
      console.log(`Loaded state: Last Etherlink block ${lastEtherlinkBlock}, Last Aptos version ${lastAptosVersion}`);
      console.log(`Pending swaps: ${Object.keys(pendingSwaps).length}`);
    } else {
      console.log('No previous state found, starting fresh');
    }
  } catch (error) {
    console.warn('Error loading state:', error);
    console.log('Starting with fresh state');
  }
}

/**
 * Monitor events on Etherlink for SwapInitiated events
 */
async function monitorEtherlinkEvents(): Promise<void> {
  try {
    // Get current block
    const currentBlock = await etherlinkProvider.getBlockNumber();
    
    if (lastEtherlinkBlock === 0) {
      // First run, start from recent block to avoid processing historical events
      lastEtherlinkBlock = Math.max(0, currentBlock - 100);
    }
    
    if (currentBlock <= lastEtherlinkBlock) {
      return; // No new blocks
    }
    
    console.log(`Checking Etherlink events from block ${lastEtherlinkBlock} to ${currentBlock}`);
    
    // Query for SwapInitiated events
    const filter = bridgeContract.filters.SwapInitiated();
    const events = await bridgeContract.queryFilter(filter, lastEtherlinkBlock + 1, currentBlock);
    
    for (const event of events) {
      const { swapId, sender, recipient, amount, secretHash, targetChain } = event.args || {};
      
      // Only process events for Aptos target chain
      if (targetChain === 'Aptos') {
        console.log(`Found new Etherlink->Aptos swap: ${swapId}`);
        
        // Store in pending swaps
        pendingSwaps[swapId] = {
          id: swapId,
          sourceChain: 'Etherlink',
          destinationChain: 'Aptos',
          sender: sender,
          recipient: recipient,
          amount: ethers.utils.formatEther(amount),
          secretHash: secretHash,
          timestamp: Date.now(),
        };
        
        console.log(`Added pending swap ${swapId} to queue`);
      }
    }
    
    // Update last processed block
    lastEtherlinkBlock = currentBlock;
    saveRelayerState();
    
  } catch (error) {
    console.error('Error monitoring Etherlink events:', error);
  }
}

/**
 * Monitor events on Aptos for swap initiation
 */
async function monitorAptosEvents(): Promise<void> {
  try {
    // Get current version
    const ledgerInfo = await aptosClient.getLedgerInfo();
    const currentVersion = parseInt(ledgerInfo.ledger_version, 10);
    
    if (lastAptosVersion === 0) {
      // First run, start from recent version to avoid processing historical events
      lastAptosVersion = Math.max(0, currentVersion - 1000);
    }
    
    if (currentVersion <= lastAptosVersion) {
      return; // No new transactions
    }
    
    console.log(`Checking Aptos events from version ${lastAptosVersion} to ${currentVersion}`);
    
    // Query for SwapInitiated events using the indexer
    // Note: This is a simplified implementation
    // In a production environment, you would use the Aptos indexer GraphQL API
    
    // For now, we'll use the REST API to get transactions for the module
    const transactions = await aptosClient.getAccountTransactions(
      config.aptosModuleAddress,
      { start: lastAptosVersion, limit: 100 }
    );
    
    for (const tx of transactions) {
      if (tx.type === 'user_transaction' && 
          tx.payload.type === 'entry_function_payload' && 
          tx.payload.function.includes(`${config.aptosModuleName}::initiate_swap`)) {
        
        // This is a swap initiation, extract details
        // In a production environment, you would parse events properly
        const eventData = tx.events.find(e => 
          e.type.includes(`${config.aptosModuleName}::SwapInitiatedEvent`)
        );
        
        if (eventData) {
          const { lock_id, sender, target_chain } = eventData.data;
          
          // Only process events for Etherlink target chain
          if (target_chain === 'Etherlink') {
            console.log(`Found new Aptos->Etherlink swap: ${lock_id}`);
            
            pendingSwaps[lock_id] = {
              id: lock_id,
              sourceChain: 'Aptos',
              destinationChain: 'Etherlink',
              sender: sender,
              recipient: eventData.data.target_address,
              amount: (eventData.data.amount / 1e8).toString(),
              secretHash: eventData.data.secret_hash,
              timestamp: Date.now(),
            };
            
            console.log(`Added pending swap ${lock_id} to queue`);
          }
        }
      }
    }
    
    // Update last processed version
    lastAptosVersion = currentVersion;
    saveRelayerState();
    
  } catch (error) {
    console.error('Error monitoring Aptos events:', error);
  }
}

/**
 * Process pending swaps
 */
async function processPendingSwaps(): Promise<void> {
  try {
    const swapIds = Object.keys(pendingSwaps);
    if (swapIds.length === 0) {
      return;
    }
    
    console.log(`Processing ${swapIds.length} pending swaps`);
    
    for (const swapId of swapIds) {
      const swap = pendingSwaps[swapId];
      
      // Check if swap is from Etherlink to Aptos
      if (swap.sourceChain === 'Etherlink' && swap.destinationChain === 'Aptos') {
        try {
          // In a real implementation, we would need to get the secret
          // Here we assume we have access to the secret through some secure channel
          // or that the secret is revealed in an event
          
          // For demonstration purposes only:
          // Look for the secret in swap details files
          const swapDetailsPath = path.join(__dirname, `swap_${swapId}.json`);
          if (fs.existsSync(swapDetailsPath)) {
            const swapDetails = JSON.parse(fs.readFileSync(swapDetailsPath, 'utf8'));
            
            if (swapDetails.secret) {
              console.log(`Completing Etherlink->Aptos swap ${swapId}`);
              await completeEtherlinkToAptosSwap(swapId);
              
              // Remove from pending
              delete pendingSwaps[swapId];
              console.log(`Completed and removed swap ${swapId}`);
            } else {
              console.log(`Waiting for secret for swap ${swapId}`);
            }
          } else {
            console.log(`No swap details file found for ${swapId}`);
          }
        } catch (error) {
          console.error(`Error processing Etherlink->Aptos swap ${swapId}:`, error);
        }
      }
      
      // Check if swap is from Aptos to Etherlink
      else if (swap.sourceChain === 'Aptos' && swap.destinationChain === 'Etherlink') {
        try {
          // Similar approach for Aptos to Etherlink swaps
          const swapDetailsPath = path.join(__dirname, `swap_${swapId}.json`);
          if (fs.existsSync(swapDetailsPath)) {
            const swapDetails = JSON.parse(fs.readFileSync(swapDetailsPath, 'utf8'));
            
            if (swapDetails.secret) {
              console.log(`Completing Aptos->Etherlink swap ${swapId}`);
              await completeAptosToEtherlinkSwap(swapId);
              
              // Remove from pending
              delete pendingSwaps[swapId];
              console.log(`Completed and removed swap ${swapId}`);
            } else {
              console.log(`Waiting for secret for swap ${swapId}`);
            }
          } else {
            console.log(`No swap details file found for ${swapId}`);
          }
        } catch (error) {
          console.error(`Error processing Aptos->Etherlink swap ${swapId}:`, error);
        }
      }
    }
    
    // Save state after processing
    saveRelayerState();
    
  } catch (error) {
    console.error('Error processing pending swaps:', error);
  }
}

/**
 * Main relayer loop
 */
async function startRelayer(): Promise<void> {
  console.log('Starting Unreal cross-chain relayer...');
  console.log(`Monitoring Etherlink bridge at ${config.etherlinkBridgeAddress}`);
  console.log(`Monitoring Aptos module at ${config.aptosModuleAddress}::${config.aptosModuleName}`);
  
  // Load previous state
  loadRelayerState();
  
  // Run initial checks
  await monitorEtherlinkEvents();
  await monitorAptosEvents();
  await processPendingSwaps();
  
  // Set up interval for continuous monitoring
  setInterval(async () => {
    try {
      await monitorEtherlinkEvents();
      await monitorAptosEvents();
      await processPendingSwaps();
    } catch (error) {
      console.error('Error in relayer loop:', error);
    }
  }, config.pollInterval);
  
  console.log(`Relayer running, polling every ${config.pollInterval / 1000} seconds`);
}

// Run the relayer if executed directly
if (require.main === module) {
  startRelayer()
    .catch(error => {
      console.error('Fatal error in relayer:', error);
      process.exit(1);
    });
}

export { startRelayer };
