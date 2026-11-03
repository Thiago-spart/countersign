use near_sdk::json_types::U64;
use near_sdk::{AccountId, BorshStorageKey, near};

/// Why a reporter thinks the target is bad. Serializes as a lowercase string.
#[near(serializers = [json, borsh])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Scam,
    Phishing,
    Drainer,
    Impersonation,
    Other,
}

/// JSON shape returned by `get_reports`. Not stored as-is: see `StoredReport`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub reporter: AccountId,
    pub category: Category,
    pub tx_hash: Option<String>,
    pub note: String,
    /// Block timestamp in nanoseconds.
    pub created_at: U64,
}

/// On-chain form of a report. The reporter is the inner map key, so it is
/// not stored again here (saves 4 + len(reporter) bytes per report, which
/// keeps the worst case under the vault's 0.01 NEAR forward).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct StoredReport {
    pub category: Category,
    pub tx_hash: Option<String>,
    pub note: String,
    pub created_at: U64,
}

impl StoredReport {
    pub fn to_report(&self, reporter: &AccountId) -> Report {
        Report {
            reporter: reporter.clone(),
            category: self.category,
            tx_hash: self.tx_hash.clone(),
            note: self.note.clone(),
            created_at: self.created_at,
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Rebuttal {
    pub note: String,
    /// Block timestamp in nanoseconds.
    pub created_at: U64,
}

/// Aggregate per target, read cross-contract by the vault.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Summary {
    /// Number of reports currently stored for the target.
    pub reports: u32,
    /// Timestamp (ns) of the earliest report still counted. Reset to `None`
    /// when the count drops to zero; otherwise not recomputed on withdraw, so
    /// after withdrawals it may predate the oldest stored report.
    pub first_seen: Option<U64>,
    /// Timestamp (ns) of the latest report added. Same caveat as `first_seen`.
    pub last_seen: Option<U64>,
    pub rebutted: bool,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
pub enum StorageKey {
    Reports,
    /// Inner per-target map; keyed by sha256(target) to keep prefixes fixed-size.
    TargetReports {
        target_hash: Vec<u8>,
    },
    Summaries,
    Rebuttals,
}
