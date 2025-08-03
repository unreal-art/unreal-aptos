set shell := ["sh", "-c"]
set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]
#set allow-duplicate-recipe
#set positional-arguments
set dotenv-filename := ".env"
set export

import? "local.justfile"

APTOS_ACCOUNT := env("APTOS_ACCOUNT")
SOLVER_PRIVATE_KEY := env("SOLVER_PRIVATE_KEY")

ORDERFILE := "order.json"


config:
    echo "Config wallet for this project"
    aptos init

deploy:
    aptos move compile --named-addresses unreal=${APTOS_ACCOUNT}
    aptos move publish --named-addresses unreal=${APTOS_ACCOUNT} --assume-yes

deploy-test:
    aptos move test --named-addresses unreal=${APTOS_ACCOUNT}

init-token:
    aptos move run --function-id ${APTOS_ACCOUNT}::unreal_token::initialize --assume-yes

setup-htlc:
    aptos move run --function-id ${APTOS_ACCOUNT}::unreal_htlc::initialize --assume-yes

add-relayer RELAYER_ADDRESS:
    aptos move run --function-id ${APTOS_ACCOUNT}::unreal_htlc::add_relayer --args address:{{RELAYER_ADDRESS}} --assume-yes

create-order:
    bun run fusion-cross-chain create-order {{SOLVER_PRIVATE_KEY}} {{ORDERFILE}}

start-solver orderfile=ORDERFILE:
    bun run fusion-cross-chain start-solver {{SOLVER_PRIVATE_KEY}} {{orderfile}}
    
# Create a swap from Aptos to Etherlink
initiate-swap SECRET_HASH RECIPIENT AMOUNT TIMELOCK_HOURS EVM_CHAIN_NAME EVM_ADDRESS TIMESTAMP:
    aptos move run --function-id ${APTOS_ACCOUNT}::unreal_htlc::initiate_swap \
    --args "hex:{{SECRET_HASH}}" \
    --args "address:{{RECIPIENT}}" \
    --args "u64:{{AMOUNT}}" \
    --args "u64:{{TIMELOCK_HOURS}}" \
    --args "string:{{EVM_CHAIN_NAME}}" \
    --args "string:{{EVM_ADDRESS}}" \
    --args "u64:{{TIMESTAMP}}" \
    --assume-yes

# Lock funds on Aptos for Etherlink->Aptos swap (EVM->Aptos)
lock-funds SECRET_HASH RECIPIENT AMOUNT TIMELOCK_HOURS SOURCE_CHAIN RECEIVER_EVM TIMESTAMP:
    aptos move run --function-id ${APTOS_ACCOUNT}::unreal_htlc::initiate_swap \
    --args "hex:{{SECRET_HASH}}" \
    --args "address:{{RECIPIENT}}" \
    --args "u64:{{AMOUNT}}" \
    --args "u64:{{TIMELOCK_HOURS}}" \
    --args "string:{{SOURCE_CHAIN}}" \
    --args "string:{{RECEIVER_EVM}}" \
    --args "u64:{{TIMESTAMP}}" \
    --assume-yes

# Complete a swap from Etherlink to Aptos (called by relayer)
complete-swap EVM_CHAIN_NAME EVM_ADDRESS RECIPIENT_ADDRESS AMOUNT SECRET:
    aptos move run --function-id ${APTOS_ACCOUNT}::unreal_htlc::complete_swap \
    --args "string:{{EVM_CHAIN_NAME}}" \
    --args "string:{{EVM_ADDRESS}}" \
    --args "address:{{RECIPIENT_ADDRESS}}" \
    --args "u64:{{AMOUNT}}" \
    --args "hex:{{SECRET}}" \
    --assume-yes

# Withdraw (claim) a locked swap on Aptos – run by the recipient
claim-swap LOCK_ID PREIMAGE:
    aptos move run --function-id ${APTOS_ACCOUNT}::unreal_htlc::withdraw \
    --args "hex:{{LOCK_ID}}" \
    --args "hex:{{PREIMAGE}}" \
    --assume-yes

demo:
    @echo "Starting Etherlink ↔ Aptos bidirectional swap demo"
    @echo "Step 1: Deploy and initialize contracts on Aptos"
    just deploy
    # just init-token
    # just setup-htlc
    @echo "Step 2: Add relayer for cross-chain operations"
    just add-relayer ${RELAYER_ADDRESS}
    @echo "Step 3: Demonstrate Aptos → Etherlink swap"
    just initiate-swap ${SECRET_HASH} ${ETH_RECIPIENT} 1000 24 "Etherlink" ${ETH_ADDRESS} `date +%s`
    @echo "Step 4: Demonstrate Etherlink → Aptos swap"
    just complete-swap "Etherlink" ${ETH_ADDRESS} ${APTOS_ACCOUNT} 1000 ${SECRET}
    @echo "Bidirectional swap demonstration completed"

demo-bridge:
    @echo "Starting Etherlink → Aptos bridge demo using etherlink-bridge script"
    @echo "Step 1: Deploy and initialize contracts on Aptos"
    just deploy
    @echo "Step 2: Add relayer for cross-chain operations"
    just add-relayer ${RELAYER_ADDRESS}
    @echo "Step 3: Initiate Etherlink → Aptos swap (locks funds on Etherlink, generates swap_id and secret)"
    @echo "         Replace <amount> and <aptos_receiver_address> with actual values."
    bun etherlink-bridge etherlink-to-aptos <amount> <aptos_receiver_address>
    @echo "Step 4: Complete swap on Aptos (requires swap_id and secret from previous step)"
    @echo "         Replace <swap_id> and <secret> with actual values from Step 3 output."
    bun etherlink-bridge complete-etherlink-to-aptos <swap_id> <secret>
    @echo "Etherlink → Aptos bridge demo completed."

relayer *ARGS:
    bun run relayer {{ARGS}}

bridge *ARGS:
    bun run etherlink-bridge {{ARGS}}