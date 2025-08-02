#[test_only]
module unreal::unreal_tests {
    use std::signer;
    use std::vector;
    use std::string;
    use aptos_framework::account;
    use aptos_framework::timestamp;
    use aptos_framework::coin;
    // Updated imports to avoid name resolution conflicts
    use unreal::unreal_token;
    use unreal::unreal_htlc::{Self};

    // Test accounts
    const ADMIN_ADDR: address = @unreal;
    const USER1_ADDR: address = @0xAA;
    const USER2_ADDR: address = @0xBB;
    const RELAYER_ADDR: address = @0xCC;

    // Secret and hash for testing
    const SECRET: vector<u8> = b"this_is_a_test_secret_for_htlc";

    /// Setup test environment
    fun setup(): (signer, signer, signer, signer) {
        // Create test accounts
        let admin = account::create_account_for_test(ADMIN_ADDR);
        let user1 = account::create_account_for_test(USER1_ADDR);
        let user2 = account::create_account_for_test(USER2_ADDR);
        let relayer = account::create_account_for_test(RELAYER_ADDR);
        
        // For testing purposes, we'll skip the timestamp initialization
        // since only the framework account can initialize it
        // and focus on testing our contract logic
        
        // Initialize the Unreal token
        unreal_token::initialize(&admin);
        
        // Initialize the HTLC contract
        unreal_htlc::initialize(&admin);
        
        // Add relayer
        unreal_htlc::add_relayer(&admin, RELAYER_ADDR);
        
        (admin, user1, user2, relayer)
    }

    #[test]
    fun test_initialization() {
        let (admin, _, _, _) = setup();
        let (owner, relayer_count, lock_contract_count) = unreal_htlc::get_contract_details();
        
        assert!(owner == signer::address_of(&admin), 0);
        assert!(relayer_count == 1, 0); // We added one relayer in setup
        assert!(lock_contract_count == 0, 0); // No lock contracts yet
    }
    
    #[test]
    fun test_relayer_management() {
        let (admin, user1, _, _) = setup();
        
        // Check initial state
        assert!(unreal_htlc::is_relayer(RELAYER_ADDR), 0);
        assert!(!unreal_htlc::is_relayer(USER1_ADDR), 0);
        
        // Add a new relayer
        unreal_htlc::add_relayer(&admin, USER1_ADDR);
        assert!(unreal_htlc::is_relayer(USER1_ADDR), 0);
        
        // Remove a relayer
        unreal_htlc::remove_relayer(&admin, RELAYER_ADDR);
        assert!(!unreal_htlc::is_relayer(RELAYER_ADDR), 0);
    }
    
    #[test]
    fun test_cross_chain_swap_flow() {
        let (admin, user1, user2, relayer) = setup();
        
        // Mint some tokens to user1 for testing
        let admin_addr = signer::address_of(&admin);
        let user1_addr = signer::address_of(&user1);
        let user2_addr = signer::address_of(&user2);
        
        coin::register<unreal_token::UnrealToken>(&user1);
        coin::register<unreal_token::UnrealToken>(&user2);
        
        // We don't have direct access to mint tokens in the test, 
        // so we'll use a mock transfer from admin (who has the initial supply)
        let admin_coins = coin::withdraw<unreal_token::UnrealToken>(&admin, 10000);
        coin::deposit(user1_addr, admin_coins);
        
        // Generate hash of secret for HTLC
        let secret_hash = std::hash::sha3_256(SECRET);
        
        // User1 initiates a swap to user2
        unreal_htlc::initiate_swap(
            &user1,
            secret_hash,
            user2_addr,
            1000,
            24, // 24 hour timelock
            string::utf8(b"Etherlink"),
            string::utf8(b"0x742d35Cc6634C0532925a3b844Bc454e4438f44e") // Example EVM address
        );
        
        // Check lock contract exists
        let lock_id = unreal_htlc::generate_lock_id(
            secret_hash,
            user2_addr,
            user1_addr,
            1000,
            timestamp::now_seconds() + (24 * 3600),
            timestamp::now_seconds()
        );
        assert!(unreal_htlc::has_lock_contract(lock_id), 0);
        
        // User2 withdraws the tokens using the secret
        unreal_htlc::withdraw(&user2, lock_id, SECRET);
        
        // Test a cross-chain completion from Etherlink to Aptos
        unreal_htlc::complete_swap(
            &relayer,
            string::utf8(b"Etherlink"),
            string::utf8(b"0x742d35Cc6634C0532925a3b844Bc454e4438f44e"),
            user1_addr,
            500,
            SECRET
        );
    }
    
    #[test]
    #[expected_failure(abort_code = 8)]
    fun test_refund_before_timelock() {
        let (admin, user1, user2, _) = setup();
        
        // Mint some tokens to user1 for testing
        let admin_addr = signer::address_of(&admin);
        let user1_addr = signer::address_of(&user1);
        let user2_addr = signer::address_of(&user2);
        
        coin::register<unreal_token::UnrealToken>(&user1);
        
        // We don't have direct access to mint tokens in the test, 
        // so we'll use a mock transfer from admin (who has the initial supply)
        let admin_coins = coin::withdraw<unreal_token::UnrealToken>(&admin, 10000);
        coin::deposit(user1_addr, admin_coins);
        
        // Generate hash of secret for HTLC
        let secret_hash = std::hash::sha3_256(SECRET);
        
        // User1 initiates a swap to user2
        unreal_htlc::initiate_swap(
            &user1,
            secret_hash,
            user2_addr,
            1000,
            24, // 24 hour timelock
            string::utf8(b"Etherlink"),
            string::utf8(b"0x742d35Cc6634C0532925a3b844Bc454e4438f44e") // Example EVM address
        );
        
        // Trying to refund before timelock expires should fail
        unreal_htlc::refund(&user1, secret_hash);
    }
    
    #[test]
    fun test_evm_execution() {
        let (admin, _, _, relayer) = setup();
        
        // Test executing on EVM (simulated)
        unreal_htlc::execute_on_evm(
            &relayer,
            1, // Ethereum mainnet
            string::utf8(b"0x1111111254EEB25477B68fb85Ed929f73A960582"), // 1inch router
            vector::empty<u8>(), // Empty calldata for test
            200000 // Gas limit
        );
        
        // Admin can also execute
        unreal_htlc::execute_on_evm(
            &admin,
            11155111, // Ethereum sepolia
            string::utf8(b"0x1111111254EEB25477B68fb85Ed929f73A960582"), // 1inch router
            vector::empty<u8>(), // Empty calldata for test
            200000 // Gas limit
        );
    }
}
