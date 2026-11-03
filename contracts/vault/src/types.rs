use near_sdk::json_types::U64;
use near_sdk::{AccountId, BorshStorageKey, NearToken, near};

/// Spending limits (spec §5.1). Defaults are in `Limits::default()`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Limits {
    /// Largest single payment.
    pub per_tx: NearToken,
    /// Total paid per UTC day (pay + approve + report deposits).
    pub daily: NearToken,
    /// Largest payment to an untrusted receiver before it needs approval.
    pub unknown_payee_max: NearToken,
    /// Registry report count at which a payment is queued for approval.
    pub registry_pending_threshold: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            per_tx: NearToken::from_near(1),
            daily: NearToken::from_near(5),
            unknown_payee_max: NearToken::from_millinear(100),
            registry_pending_threshold: 2,
        }
    }
}

/// Result of `pay`, `request_approval` and `approve`.
/// JSON: `{"status":"paid","receiver":..,"amount":..}`, `{"status":"pending","id":..,"reason":..}`, ...
#[near(serializers = [json])]
#[serde(tag = "status", rename_all = "snake_case")]
#[derive(Clone, Debug, PartialEq)]
pub enum PayOutcome {
    Paid {
        receiver: AccountId,
        amount: NearToken,
    },
    Pending {
        id: U64,
        reason: String,
    },
    Rejected {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

/// A payment waiting for the owner's `approve` or `deny`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingPayment {
    pub id: U64,
    pub receiver: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub reason: String,
    /// Block timestamp in nanoseconds.
    pub created_at: U64,
}

/// Amount spent (or reserved) on UTC day `day` (= `day_of(block_timestamp)`).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Spent {
    pub day: u64,
    /// yoctoNEAR
    pub amount: u128,
}

/// A per-UTC-day counter (`report` forwards).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DailyCount {
    pub day: u64,
    pub count: u32,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey {
    Trusted,
    Pending,
}
