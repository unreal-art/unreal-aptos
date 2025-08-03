module unreal::unreal_token {
    use std::error;
    use std::signer;
    use std::string;
    use aptos_framework::coin;
    use aptos_framework::account;
    
    /// Constants for the Unreal Token
    const TOKEN_NAME: vector<u8> = b"Unreal Token";
    const TOKEN_SYMBOL: vector<u8> = b"UNREAL";
    const TOKEN_DECIMALS: u8 = 6;
    const INITIAL_SUPPLY: u64 = 250_000_000_000_000; // 250M × 10⁶ 
    
    /// Error codes
    const ERR_NOT_OWNER: u64 = 1;
    const ERR_PAUSED: u64 = 2;
    const ERR_NOT_PAUSED: u64 = 3;
    
    /// Unreal token capabilities
    struct UnrealTokenCapabilities has key {
        burn_cap: coin::BurnCapability<UnrealToken>,
        freeze_cap: coin::FreezeCapability<UnrealToken>,
        mint_cap: coin::MintCapability<UnrealToken>,
    }
    
    /// Unreal token metadata
    struct UnrealToken has key {}
    
    /// Contract state for additional features
    struct UnrealState has key {
        owner: address,
        paused: bool,
    }
    
    /// Initialize the Unreal token
    public entry fun initialize(admin: &signer) {
        let admin_addr = signer::address_of(admin);
        
        // Register the token with Aptos coin framework
        let (burn_cap, freeze_cap, mint_cap) = coin::initialize<UnrealToken>(
            admin,
            string::utf8(TOKEN_NAME),
            string::utf8(TOKEN_SYMBOL),
            TOKEN_DECIMALS,
            true // monitor_supply
        );
        
        // Mint initial supply to owner before moving capabilities
        let coins = coin::mint<UnrealToken>(INITIAL_SUPPLY, &mint_cap);
        coin::register<UnrealToken>(admin);
        coin::deposit<UnrealToken>(admin_addr, coins);
        
        // Store capabilities after using them
        move_to(admin, UnrealTokenCapabilities {
            mint_cap,
            burn_cap,
            freeze_cap,
        });
        
        // Store state
        move_to(admin, UnrealState {
            owner: admin_addr,
            paused: false,
        });
    }
    
    /// Mint tokens - only owner
    public entry fun mint(
        admin: &signer,
        to: address,
        amount: u64
    ) acquires UnrealTokenCapabilities, UnrealState {
        let state = borrow_global<UnrealState>(@unreal);
        assert!(signer::address_of(admin) == state.owner, error::permission_denied(ERR_NOT_OWNER));
        assert!(!state.paused, error::invalid_state(ERR_PAUSED));
        
        let caps = borrow_global<UnrealTokenCapabilities>(@unreal);
        let coins = coin::mint<UnrealToken>(amount, &caps.mint_cap);
        
        // Register the recipient if needed
        if (!coin::is_account_registered<UnrealToken>(to)) {
            // In a real implementation, the recipient would need to register themselves
            // For this example we just register the token for them
            coin::register<UnrealToken>(admin);
        };
        
        coin::deposit<UnrealToken>(to, coins);
    }
    
    /// Burn tokens - only owner
    public entry fun burn(
        admin: &signer,
        amount: u64
    ) acquires UnrealTokenCapabilities, UnrealState {
        let state = borrow_global<UnrealState>(@unreal);
        assert!(signer::address_of(admin) == state.owner, error::permission_denied(ERR_NOT_OWNER));
        assert!(!state.paused, error::invalid_state(ERR_PAUSED));
        
        let caps = borrow_global<UnrealTokenCapabilities>(@unreal);
        let coins_to_burn = coin::withdraw<UnrealToken>(admin, amount);
        
        coin::burn<UnrealToken>(coins_to_burn, &caps.burn_cap);
    }
    
    /// Pause contract - only owner
    public entry fun pause(admin: &signer) acquires UnrealState {
        let state = borrow_global_mut<UnrealState>(@unreal);
        assert!(signer::address_of(admin) == state.owner, error::permission_denied(ERR_NOT_OWNER));
        assert!(!state.paused, error::invalid_state(ERR_NOT_PAUSED));
        
        state.paused = true;
    }
    
    /// Unpause contract - only owner
    public entry fun unpause(admin: &signer) acquires UnrealState {
        let state = borrow_global_mut<UnrealState>(@unreal);
        assert!(signer::address_of(admin) == state.owner, error::permission_denied(ERR_NOT_OWNER));
        assert!(state.paused, error::invalid_state(ERR_PAUSED));
        
        state.paused = false;
    }
    
    /// Transfer ownership - only owner
    public entry fun transfer_ownership(
        admin: &signer,
        new_owner: address
    ) acquires UnrealState {
        let state = borrow_global_mut<UnrealState>(@unreal);
        assert!(signer::address_of(admin) == state.owner, error::permission_denied(ERR_NOT_OWNER));
        
        state.owner = new_owner;
    }
    
    /// Check if contract is paused
    public fun is_paused(): bool acquires UnrealState {
        let state = borrow_global<UnrealState>(@unreal);
        state.paused
    }
    
    /// Get owner address
    public fun get_owner(): address acquires UnrealState {
        let state = borrow_global<UnrealState>(@unreal);
        state.owner
    }
}
