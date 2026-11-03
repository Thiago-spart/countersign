//! Cross-contract interface of the Countersign registry (Task 1).

use near_sdk::json_types::U64;
use near_sdk::{AccountId, ext_contract, near};

/// The registry's `get_summary` result. Only `reports` is used by `pay`;
/// `first_seen` / `last_seen` can be stale after withdrawals.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Summary {
    pub reports: u32,
    pub first_seen: Option<U64>,
    pub last_seen: Option<U64>,
    pub rebutted: bool,
}

/// The registry's report categories (it rejects anything else).
pub const CATEGORIES: [&str; 5] = ["scam", "phishing", "drainer", "impersonation", "other"];

#[allow(dead_code)]
#[ext_contract(ext_registry)]
pub trait Registry {
    fn get_summary(&self, target: AccountId) -> Summary;
    fn report(
        &mut self,
        target: AccountId,
        category: String,
        tx_hash: Option<String>,
        note: String,
    );
}
