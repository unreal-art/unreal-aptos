module unreal::unreal_htlc {
    use std::error;
    use std::signer;
    use std::string;
    use std::vector;
    use std::hash;
    use std::bcs;
    use aptos_framework::account;
    use aptos_framework::coin;
    use aptos_framework::timestamp;
    use aptos_framework::event;
    use unreal::unreal_token::UnrealToken;

    /// Error codes
    const ERR_NOT_OWNER: u64 = 1;
    const ERR_NOT_RELAYER: u64 = 2;
    const ERR_ALREADY_INITIALIZED: u64 = 3;
    const ERR_SWAP_EXISTS: u64 = 4;
    const ERR_SWAP_NOT_FOUND: u64 = 5;
    const ERR_INVALID_PREIMAGE: u64 = 6;
    const ERR_NOT_RECIPIENT: u64 = 7;
    const ERR_NOT_SENDER: u64 = 8;
    const ERR_ALREADY_WITHDRAWN: u64 = 9;
    const ERR_ALREADY_REFUNDED: u64 = 10;
    const ERR_TIMELOCK_NOT_EXPIRED: u64 = 11;
    const ERR_INVALID_EVM_ADDRESS: u64 = 12;
    const ERR_INVALID_AMOUNT: u64 = 13;

    /// Constants for gas and fees
    const HOURS_TO_SECONDS: u64 = 3600;
    const MICROSECONDS_TO_SECONDS: u64 = 1000000;

    /// ChainId enum
    struct ChainId has copy, drop, store {
        is_mainnet: bool,
        id: u64,
    }

    /// Lock contract structure
    struct LockContract has key, store {
        secret_hash: vector<u8>,
        recipient: address,
        sender: address,
        amount: u64,
        endtime: u64,
        withdrawn: bool,
        refunded: bool,
        preimage: vector<u8>,
        target_chain: string::String,
        target_address: string::String,
    }

    /// Events for cross-chain operations
    struct SwapInitiatedEvent has drop, store {
        lock_id: vector<u8>,
        sender: address,
        recipient: address,
        amount: u64,
        secret_hash: vector<u8>,
        target_chain: string::String,
        target_address: string::String,
    }

    struct SwapWithdrawnEvent has drop, store {
        lock_id: vector<u8>,
        recipient: address,
        amount: u64,
        preimage: vector<u8>,
    }

    struct SwapRefundedEvent has drop, store {
        lock_id: vector<u8>,
        sender: address,
        amount: u64,
    }

    struct CrossChainCompletedEvent has drop, store {
        source_chain: string::String,
        source_address: string::String,
        destination: address,
        amount: u64,
        preimage: vector<u8>,
    }

    struct EVMExecutionEvent has drop, store {
        evm_chain_id: u64,
        contract_address: string::String,
        calldata_length: u64,
        gas_limit: u64,
    }

    /// Contract state
    struct UnrealHTLCState has key {
        owner: address,
        relayers: vector<address>,
        lock_contracts: vector<LockContract>,
        
        // Event handles
        swap_initiated_events: event::EventHandle<SwapInitiatedEvent>,
        swap_withdrawn_events: event::EventHandle<SwapWithdrawnEvent>,
        swap_refunded_events: event::EventHandle<SwapRefundedEvent>,
        cross_chain_completed_events: event::EventHandle<CrossChainCompletedEvent>,
        evm_execution_events: event::EventHandle<EVMExecutionEvent>,
    }

    /// Initialize the HTLC contract
    public entry fun initialize(admin: &signer) {
        let admin_addr = signer::address_of(admin);
        
        // Check if already initialized
        assert!(!exists<UnrealHTLCState>(@unreal), error::already_exists(ERR_ALREADY_INITIALIZED));
        
        // Create initial state
        let state = UnrealHTLCState {
            owner: admin_addr,
            relayers: vector::empty<address>(),
            lock_contracts: vector::empty<LockContract>(),
            swap_initiated_events: event::new_event_handle<SwapInitiatedEvent>(admin),
            swap_withdrawn_events: event::new_event_handle<SwapWithdrawnEvent>(admin),
            swap_refunded_events: event::new_event_handle<SwapRefundedEvent>(admin),
            cross_chain_completed_events: event::new_event_handle<CrossChainCompletedEvent>(admin),
            evm_execution_events: event::new_event_handle<EVMExecutionEvent>(admin),
        };
        
        // Add admin as a relayer
        vector::push_back(&mut state.relayers, admin_addr);
        
        move_to(admin, state);
    }

    /// Add a relayer - only owner
    public entry fun add_relayer(admin: &signer, relayer: address) acquires UnrealHTLCState {
        let admin_addr = signer::address_of(admin);
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        
        // Verify owner
        assert!(admin_addr == state.owner, error::permission_denied(ERR_NOT_OWNER));
        
        // Add relayer if not already added
        if (!vector::contains(&state.relayers, &relayer)) {
            vector::push_back(&mut state.relayers, relayer);
        };
    }

    /// Remove a relayer - only owner
    public entry fun remove_relayer(admin: &signer, relayer: address) acquires UnrealHTLCState {
        let admin_addr = signer::address_of(admin);
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        
        // Verify owner
        assert!(admin_addr == state.owner, error::permission_denied(ERR_NOT_OWNER));
        
        // Find and remove relayer
        let (exists, index) = vector::index_of(&state.relayers, &relayer);
        if (exists) {
            vector::remove(&mut state.relayers, index);
        };
    }

    /// Find lock contract by id
    fun find_lock_contract(lock_id: vector<u8>): (bool, u64) acquires UnrealHTLCState {
        let state = borrow_global<UnrealHTLCState>(@unreal);
        let i = 0;
        let len = vector::length(&state.lock_contracts);
        
        while (i < len) {
            let lock_contract = vector::borrow(&state.lock_contracts, i);
            // Create an id for this contract using sender, recipient, secret_hash
            let contract_id = bcs::to_bytes(&lock_contract.secret_hash);
            
            if (contract_id == lock_id) {
                return (true, i)
            };
            
            i = i + 1;
        };
        
        (false, 0)
    }

    /// Initiate a swap to another chain
    public entry fun initiate_swap(
        sender: &signer,
        amount: u64,
        recipient: address,
        secret_hash: vector<u8>,
        timelock_hours: u64,
        target_chain: string::String,
        target_address: string::String
    ) acquires UnrealHTLCState {
        // Verify inputs
        assert!(amount > 0, error::invalid_argument(ERR_INVALID_AMOUNT));
        assert!(vector::length(&secret_hash) == 32, error::invalid_argument(ERR_INVALID_PREIMAGE));
        
        let sender_addr = signer::address_of(sender);
        let lock_id = secret_hash; // Using the secret hash as the lock ID
        
        // Check if swap already exists
        let (exists, _) = find_lock_contract(lock_id);
        assert!(!exists, error::already_exists(ERR_SWAP_EXISTS));
        
        // Calculate timelock
        let current_time = timestamp::now_seconds();
        let endtime = current_time + (timelock_hours * HOURS_TO_SECONDS);
        
        // Create lock contract
        let lock_contract = LockContract {
            secret_hash,
            recipient,
            sender: sender_addr,
            amount,
            endtime,
            withdrawn: false,
            refunded: false,
            preimage: vector::empty<u8>(),
            target_chain,
            target_address,
        };
        
        // Withdraw tokens from sender
        let coins = coin::withdraw<UnrealToken>(sender, amount);
        
        // Add to lock contracts
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        vector::push_back(&mut state.lock_contracts, lock_contract);
        
        // For production deployment, the module account needs to be initialized separately
        // Assume the contract account is already set up
        if (!coin::is_account_registered<UnrealToken>(@unreal)) {
            // In a production environment, this would have been done beforehand
            coin::register<UnrealToken>(sender);
        };
        
        // Deposit tokens to contract account
        coin::deposit<UnrealToken>(@unreal, coins);
        
        // Emit event
        event::emit_event(
            &mut state.swap_initiated_events,
            SwapInitiatedEvent {
                lock_id,
                sender: sender_addr,
                recipient,
                amount,
                secret_hash,
                target_chain,
                target_address,
            }
        );
    }

    /// Helper function to get chain id
    public fun get_etherlink_testnet_chain_id(): ChainId {
        ChainId {
            is_mainnet: false,
            id: 128123,
        }
    }

    /// Helper function to get chain id as string
    public fun chain_id_to_string(chain_id: &ChainId): string::String {
        if (chain_id.is_mainnet) {
            string::utf8(b"etherlink_mainnet")
        } else {
            string::utf8(b"etherlink_testnet")
        }
    }

    /// Check if address is a relayer
    public fun is_relayer(addr: address): bool acquires UnrealHTLCState {
        let state = borrow_global<UnrealHTLCState>(@unreal);
        vector::contains(&state.relayers, &addr)
    }
}
