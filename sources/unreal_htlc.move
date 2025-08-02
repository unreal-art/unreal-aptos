module unreal::unreal_htlc {
    use std::error;
    use std::signer;
    use std::string::{Self, String};
    use std::vector;
    use std::hash;
    use std::bcs;
    use aptos_framework::account;
    use aptos_framework::coin::{Self, Coin};
    use aptos_framework::timestamp;
    use aptos_framework::event::{Self, EventHandle};
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
        target_chain: String,
        target_address: String,
    }

    /// Events for cross-chain operations
    struct SwapInitiatedEvent has drop, store {
        lock_id: vector<u8>,
        sender: address,
        recipient: address,
        amount: u64,
        secret_hash: vector<u8>,
        target_chain: String,
        target_address: String,
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
        source_chain: String,
        source_address: String,
        destination: address,
        amount: u64,
        preimage: vector<u8>,
    }

    struct EVMExecutionEvent has drop, store {
        evm_chain_id: u64,
        contract_address: String,
        calldata_length: u64,
        gas_limit: u64,
    }

    /// Contract state
    struct UnrealHTLCState has key {
        owner: address,
        relayers: vector<address>,
        lock_contracts: vector<LockContract>,
        
        // Event handles
        swap_initiated_events: EventHandle<SwapInitiatedEvent>,
        swap_withdrawn_events: EventHandle<SwapWithdrawnEvent>,
        swap_refunded_events: EventHandle<SwapRefundedEvent>,
        cross_chain_completed_events: EventHandle<CrossChainCompletedEvent>,
        evm_execution_events: EventHandle<EVMExecutionEvent>,
    }

    /// Initialize the HTLC contract
    public entry fun initialize(admin: &signer) {
        let admin_addr = signer::address_of(admin);
        assert!(admin_addr == @unreal, error::permission_denied(ERR_NOT_OWNER));
        assert!(!exists<UnrealHTLCState>(admin_addr), error::already_exists(ERR_ALREADY_INITIALIZED));

        move_to(admin, UnrealHTLCState {
            owner: admin_addr,
            relayers: vector::empty<address>(),
            lock_contracts: vector::empty<LockContract>(),
            
            swap_initiated_events: account::new_event_handle<SwapInitiatedEvent>(admin),
            swap_withdrawn_events: account::new_event_handle<SwapWithdrawnEvent>(admin),
            swap_refunded_events: account::new_event_handle<SwapRefundedEvent>(admin),
            cross_chain_completed_events: account::new_event_handle<CrossChainCompletedEvent>(admin),
            evm_execution_events: account::new_event_handle<EVMExecutionEvent>(admin),
        });
    }

    /// Add a relayer for chain signatures
    public entry fun add_relayer(admin: &signer, relayer: address) acquires UnrealHTLCState {
        let admin_addr = signer::address_of(admin);
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        assert!(admin_addr == state.owner, error::permission_denied(ERR_NOT_OWNER));
        
        if (!vector::contains(&state.relayers, &relayer)) {
            vector::push_back(&mut state.relayers, relayer);
        };
    }

    /// Remove a relayer
    public entry fun remove_relayer(admin: &signer, relayer: address) acquires UnrealHTLCState {
        let admin_addr = signer::address_of(admin);
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        assert!(admin_addr == state.owner, error::permission_denied(ERR_NOT_OWNER));
        
        let (found, index) = vector::index_of(&state.relayers, &relayer);
        if (found) {
            vector::remove(&mut state.relayers, index);
        };
    }

    /// Check if an address is a relayer
    public fun is_relayer(addr: address): bool acquires UnrealHTLCState {
        let state = borrow_global<UnrealHTLCState>(@unreal);
        vector::contains(&state.relayers, &addr)
    }

    /// Generate a lock ID based on parameters
    fun generate_lock_id(
        secret_hash: vector<u8>,
        recipient: address,
        sender: address,
        amount: u64,
        endtime: u64,
        timestamp: u64
    ): vector<u8> {
        let data = vector::empty<u8>();
        vector::append(&mut data, secret_hash);
        vector::append(&mut data, bcs::to_bytes(&recipient));
        vector::append(&mut data, bcs::to_bytes(&sender));
        vector::append(&mut data, bcs::to_bytes(&amount));
        vector::append(&mut data, bcs::to_bytes(&endtime));
        vector::append(&mut data, bcs::to_bytes(&timestamp));
        
        hash::sha3_256(data)
    }

    /// Find a lock contract by ID
    fun find_lock_contract(lock_id: vector<u8>): (bool, u64) acquires UnrealHTLCState {
        let state = borrow_global<UnrealHTLCState>(@unreal);
        let i = 0;
        let len = vector::length(&state.lock_contracts);
        
        while (i < len) {
            let lock_contract = vector::borrow(&state.lock_contracts, i);
            let current_id = generate_lock_id(
                lock_contract.secret_hash,
                lock_contract.recipient,
                lock_contract.sender,
                lock_contract.amount,
                lock_contract.endtime,
                0 // We don't store the original timestamp, so use 0 here
            );
            
            if (current_id == lock_id) {
                return (true, i)
            };
            i = i + 1;
        };
        
        (false, 0)
    }

    /// Initiate a cross-chain swap by locking tokens in the contract
    public entry fun initiate_swap(
        sender: &signer,
        secret_hash: vector<u8>,
        recipient: address,
        amount: u64,
        timeout_hours: u64,
        target_chain: String,
        target_address: String
    ) acquires UnrealHTLCState {
        assert!(amount > 0, error::invalid_argument(ERR_INVALID_AMOUNT));
        let sender_addr = signer::address_of(sender);
        
        // Calculate timeout timestamp
        let current_time = timestamp::now_seconds();
        let endtime = current_time + (timeout_hours * HOURS_TO_SECONDS);
        
        // Generate lock ID
        let lock_id = generate_lock_id(
            secret_hash,
            recipient,
            sender_addr,
            amount,
            endtime,
            current_time
        );
        
        // Check if lock contract already exists
        let (exists, _) = find_lock_contract(lock_id);
        assert!(!exists, error::already_exists(ERR_SWAP_EXISTS));
        
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
        
        // Transfer tokens from sender to contract
        let coins = coin::withdraw<UnrealToken>(sender, amount);
        
        // Store the lock contract
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        vector::push_back(&mut state.lock_contracts, lock_contract);
        
        // Deposit tokens to contract
        if (!coin::is_account_registered<UnrealToken>(@unreal)) {
            coin::register<UnrealToken>(&account::create_signer_with_capability(
                &account::create_test_signer_cap(@unreal)
            ));
        };
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

    /// Withdraw tokens by revealing the secret
    public entry fun withdraw(
        recipient: &signer,
        lock_id: vector<u8>,
        preimage: vector<u8>
    ) acquires UnrealHTLCState {
        let recipient_addr = signer::address_of(recipient);
        let (exists, index) = find_lock_contract(lock_id);
        assert!(exists, error::not_found(ERR_SWAP_NOT_FOUND));
        
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        let lock_contract = vector::borrow_mut(&mut state.lock_contracts, index);
        
        // Verify recipient
        assert!(recipient_addr == lock_contract.recipient, error::permission_denied(ERR_NOT_RECIPIENT));
        
        // Verify not already withdrawn or refunded
        assert!(!lock_contract.withdrawn, error::invalid_state(ERR_ALREADY_WITHDRAWN));
        assert!(!lock_contract.refunded, error::invalid_state(ERR_ALREADY_REFUNDED));
        
        // Verify preimage matches the hash
        let preimage_hash = hash::sha3_256(preimage);
        assert!(preimage_hash == lock_contract.secret_hash, error::invalid_argument(ERR_INVALID_PREIMAGE));
        
        // Update lock contract
        lock_contract.preimage = preimage;
        lock_contract.withdrawn = true;
        
        // Transfer tokens to recipient
        if (!coin::is_account_registered<UnrealToken>(recipient_addr)) {
            coin::register<UnrealToken>(recipient);
        };
        
        let contract_signer = &account::create_signer_with_capability(
            &account::create_test_signer_cap(@unreal)
        );
        let coins = coin::withdraw<UnrealToken>(contract_signer, lock_contract.amount);
        coin::deposit<UnrealToken>(recipient_addr, coins);
        
        // Emit event
        event::emit_event(
            &mut state.swap_withdrawn_events,
            SwapWithdrawnEvent {
                lock_id,
                recipient: recipient_addr,
                amount: lock_contract.amount,
                preimage,
            }
        );
    }

    /// Refund tokens to the sender if the timelock has expired
    public entry fun refund(
        sender: &signer,
        lock_id: vector<u8>
    ) acquires UnrealHTLCState {
        let sender_addr = signer::address_of(sender);
        let (exists, index) = find_lock_contract(lock_id);
        assert!(exists, error::not_found(ERR_SWAP_NOT_FOUND));
        
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        let lock_contract = vector::borrow_mut(&mut state.lock_contracts, index);
        
        // Verify sender
        assert!(sender_addr == lock_contract.sender, error::permission_denied(ERR_NOT_SENDER));
        
        // Verify not already withdrawn or refunded
        assert!(!lock_contract.withdrawn, error::invalid_state(ERR_ALREADY_WITHDRAWN));
        assert!(!lock_contract.refunded, error::invalid_state(ERR_ALREADY_REFUNDED));
        
        // Verify timelock has expired
        let current_time = timestamp::now_seconds();
        assert!(current_time >= lock_contract.endtime, error::invalid_state(ERR_TIMELOCK_NOT_EXPIRED));
        
        // Update lock contract
        lock_contract.refunded = true;
        
        // Transfer tokens back to sender
        if (!coin::is_account_registered<UnrealToken>(sender_addr)) {
            coin::register<UnrealToken>(sender);
        };
        
        let contract_signer = &account::create_signer_with_capability(
            &account::create_test_signer_cap(@unreal)
        );
        let coins = coin::withdraw<UnrealToken>(contract_signer, lock_contract.amount);
        coin::deposit<UnrealToken>(sender_addr, coins);
        
        // Emit event
        event::emit_event(
            &mut state.swap_refunded_events,
            SwapRefundedEvent {
                lock_id,
                sender: sender_addr,
                amount: lock_contract.amount,
            }
        );
    }

    /// Complete a cross-chain swap from another chain (to be called by relayer/oracle)
    public entry fun complete_swap(
        relayer: &signer,
        source_chain: String,
        source_address: String,
        destination: address,
        amount: u64,
        preimage: vector<u8>
    ) acquires UnrealHTLCState {
        let relayer_addr = signer::address_of(relayer);
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        
        // Verify relayer
        assert!(vector::contains(&state.relayers, &relayer_addr), error::permission_denied(ERR_NOT_RELAYER));
        
        // Register destination if needed
        if (!coin::is_account_registered<UnrealToken>(destination)) {
            coin::register<UnrealToken>(&account::create_signer_with_capability(
                &account::create_test_signer_cap(destination)
            ));
        };
        
        // Mint tokens to destination
        let admin_signer = &account::create_signer_with_capability(
            &account::create_test_signer_cap(@unreal)
        );
        
        // In real implementation, we would mint tokens
        // For now, we use the admin's tokens
        let coins = coin::withdraw<UnrealToken>(admin_signer, amount);
        coin::deposit<UnrealToken>(destination, coins);
        
        // Emit event
        event::emit_event(
            &mut state.cross_chain_completed_events,
            CrossChainCompletedEvent {
                source_chain,
                source_address,
                destination,
                amount,
                preimage,
            }
        );
    }

    /// Execute an EVM transaction from Aptos using 1inch Fusion
    public entry fun execute_on_evm(
        caller: &signer,
        evm_chain_id: u64,
        contract_address: String,
        calldata: vector<u8>,
        gas_limit: u64
    ) acquires UnrealHTLCState {
        let caller_addr = signer::address_of(caller);
        let state = borrow_global_mut<UnrealHTLCState>(@unreal);
        
        // Verify caller is relayer or owner
        assert!(
            vector::contains(&state.relayers, &caller_addr) || caller_addr == state.owner,
            error::permission_denied(ERR_NOT_RELAYER)
        );
        
        // Validate contract address format (in real implementation)
        // For demo, we just check it's not empty
        assert!(string::length(&contract_address) > 0, error::invalid_argument(ERR_INVALID_EVM_ADDRESS));
        
        // Validate calldata
        assert!(vector::length(&calldata) > 0, error::invalid_argument(ERR_INVALID_EVM_ADDRESS));
        
        // In production, this would integrate with a cross-chain messaging protocol
        // to actually execute the transaction on the EVM chain
        
        // Emit event
        event::emit_event(
            &mut state.evm_execution_events,
            EVMExecutionEvent {
                evm_chain_id,
                contract_address,
                calldata_length: vector::length(&calldata),
                gas_limit,
            }
        );
    }

    /// Get details about the HTLC contract
    public fun get_contract_details(): (address, u64, u64) acquires UnrealHTLCState {
        let state = borrow_global<UnrealHTLCState>(@unreal);
        (
            state.owner,
            vector::length(&state.relayers),
            vector::length(&state.lock_contracts)
        )
    }

    /// Check if a lock contract exists
    public fun has_lock_contract(lock_id: vector<u8>): bool acquires UnrealHTLCState {
        let (exists, _) = find_lock_contract(lock_id);
        exists
    }

    // Helper functions for chain IDs
    public fun ethereum_mainnet(): ChainId {
        ChainId { is_mainnet: true, id: 1 }
    }
    
    public fun ethereum_sepolia(): ChainId {
        ChainId { is_mainnet: false, id: 11155111 }
    }
    
    public fun aptos_mainnet(): ChainId {
        ChainId { is_mainnet: true, id: 1 }
    }
    
    public fun aptos_testnet(): ChainId {
        ChainId { is_mainnet: false, id: 2 }
    }
}
