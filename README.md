# Unreal Aptos Integration

This directory contains the Aptos integration for the Unreal cross-chain bridge between Etherlink and Aptos using 1inch Fusion+ for cross-chain swaps.

## Overview

The Unreal Aptos integration allows:
- Cross-chain token swaps between Etherlink and Aptos using Hash Time Locked Contracts (HTLCs)
- Execution of EVM transactions from Aptos using 1inch Fusion+
- Secure token bridging with atomic swaps

## Directory Structure

- `sources/` - Move smart contracts for Aptos
  - `unreal_token.move` - Implementation of the Unreal token on Aptos
  - `unreal_htlc.move` - HTLC implementation for cross-chain swaps
- `scripts/` - TypeScript utilities for integrating with Etherlink
  - `etherlink_bridge.ts` - Cross-chain bridge utility
- `tests/` - Unit tests for the Move contracts
  - `unreal_tests.move` - Tests for HTLC functionality

## Prerequisites

- [Aptos CLI](https://aptos.dev/tools/aptos-cli/install-cli/)
- Node.js v16+ and npm
- Access to Etherlink RPC endpoint
- Aptos account with test tokens

## Setup

1. Copy `.env.example` to `.env` and fill in your configuration:

```bash
cp .env.example .env
```

2. Update the following values in your `.env` file:
   - `APTOS_PRIVATE_KEY` - Your Aptos private key
   - `ETHERLINK_PRIVATE_KEY` - Your Etherlink private key
   - `ETHERLINK_BRIDGE_ADDRESS` - Address of UnrealBridge.sol on Etherlink
   - `UNREAL_TOKEN_ADDRESS` - Address of UnrealToken.sol on Etherlink

3. Install dependencies:

```bash
npm install
```

## Deploying the Contracts

Deploy the Move modules to Aptos:

```bash
aptos move publish --named-addresses unreal=YOUR_APTOS_ADDRESS
```

## Cross-Chain Swap Flow

### Etherlink to Aptos

1. Initiate a swap on Etherlink:

```bash
npm run etherlink-bridge -- etherlink-to-aptos 10.0 0xaptosReceiverAddress
```

This will:
- Lock UNREAL tokens in the Etherlink bridge
- Generate a secret and hash
- Store swap details locally

2. Complete the swap on Aptos:

```bash
npm run etherlink-bridge -- complete-aptos [swap_id]
```

This will:
- Verify the secret
- Mint UNREAL tokens to the recipient on Aptos

### Aptos to Etherlink

1. Initiate a swap on Aptos:

```bash
npm run etherlink-bridge -- aptos-to-etherlink 10.0 0xetherlinkReceiverAddress
```

This will:
- Lock UNREAL tokens in the Aptos bridge
- Generate a secret and hash
- Store swap details locally

2. Complete the swap on Etherlink:

```bash
npm run etherlink-bridge -- complete-etherlink [swap_id]
```

This will:
- Verify the secret
- Release UNREAL tokens to the recipient on Etherlink

## Using 1inch Fusion+ from Aptos

Execute transactions on EVM chains from Aptos:

```bash
npm run etherlink-bridge -- execute-evm [chain_id] [contract_address] [calldata] [gas_limit]
```

Example:

```bash
npm run etherlink-bridge -- execute-evm 11155111 0x1111111254EEB25477B68fb85Ed929f73A960582 0x... 200000
```

## Running Tests

Test the Move contracts:

```bash
aptos move test --named-addresses unreal=0x1
```

## Integration with UnrealBridge.sol

This Aptos implementation is designed to work with the UnrealBridge.sol contract deployed on Etherlink. The bridge utilizes HTLCs for secure cross-chain token transfers with the following features:

- Atomic swaps between Etherlink and Aptos
- Timelock mechanism for security
- Support for 1inch Fusion+ cross-chain transactions
- Event emission for off-chain monitoring

## Development Notes

The integration between Etherlink and Aptos works by:

1. Using HTLCs to lock tokens on the source chain
2. Revealing a secret to unlock tokens on the destination chain
3. Emitting events that can be monitored by relayers
4. Using 1inch Fusion+ for complex cross-chain DeFi operations

## Security Considerations

- The security of cross-chain operations depends on the secrecy of the preimage
- Timelocks prevent funds from being locked indefinitely
- Only authorized relayers can complete cross-chain operations
- Owner can pause operations in emergency situations
