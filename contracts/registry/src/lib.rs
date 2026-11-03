//! Countersign registry: a shared, ownerless list of reports about bad NEAR
//! accounts (spec §5.2).
//!
//! Anyone can report a target once, paying for the storage they use; reporters
//! can withdraw and get that storage refunded; a target can attach a single
//! rebuttal. There are no admin, owner or upgrade methods.

pub mod events;
pub mod types;

use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{AccountId, NearToken, Promise, env, near, require};

use crate::events::RegistryEvent;
use crate::types::StorageKey;
pub use crate::types::{Category, Rebuttal, Report, Summary};

/// Minimum deposit attached to `report` / `rebut` (anti-spam gate).
pub const MIN_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Maximum note length in bytes for reports and rebuttals.
pub const MAX_NOTE_BYTES: usize = 280;
/// Maximum `tx_hash` length in bytes (base58 tx hashes are ~44 chars).
pub const MAX_TX_HASH_BYTES: usize = 64;
/// Upper bound on `get_reports` page size, to keep view gas bounded.
pub const MAX_PAGE: u32 = 100;

#[near(contract_state)]
pub struct Contract {
    /// target -> reporter -> report
    reports: LookupMap<AccountId, IterableMap<AccountId, Report>>,
    summaries: LookupMap<AccountId, Summary>,
    rebuttals: LookupMap<AccountId, Rebuttal>,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            reports: LookupMap::new(StorageKey::Reports),
            summaries: LookupMap::new(StorageKey::Summaries),
            rebuttals: LookupMap::new(StorageKey::Rebuttals),
        }
    }
}

fn storage_cost(bytes: u64) -> NearToken {
    env::storage_byte_cost().saturating_mul(u128::from(bytes))
}

fn refund(to: &AccountId, amount: NearToken) {
    if !amount.is_zero() {
        Promise::new(to.clone()).transfer(amount).detach();
    }
}

fn require_note(note: &str) {
    require!(note.len() <= MAX_NOTE_BYTES, "note exceeds 280 bytes");
}

#[near]
impl Contract {
    /// Report `target`. Attach at least 0.01 NEAR; the measured storage cost
    /// is kept and the rest refunded.
    #[payable]
    pub fn report(
        &mut self,
        target: AccountId,
        category: Category,
        tx_hash: Option<String>,
        note: String,
    ) {
        let reporter = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, "attach at least 0.01 NEAR");
        require!(target != reporter, "cannot report yourself");
        require_note(&note);
        if let Some(h) = &tx_hash {
            require!(h.len() <= MAX_TX_HASH_BYTES, "tx_hash exceeds 64 bytes");
        }

        let before = env::storage_usage();
        let now = U64(env::block_timestamp());

        let inner = self.reports.entry(target.clone()).or_insert_with(|| {
            IterableMap::new(StorageKey::TargetReports {
                target_hash: env::sha256(target.as_bytes()),
            })
        });
        require!(
            !inner.contains_key(&reporter),
            "already reported this target"
        );
        inner.insert(
            reporter.clone(),
            Report {
                reporter: reporter.clone(),
                category,
                tx_hash,
                note,
                created_at: now,
            },
        );
        // Write the inner map's entries now so storage_usage reflects them.
        inner.flush();

        let mut summary = self.summaries.get(&target).cloned().unwrap_or_default();
        summary.reports = summary.reports.saturating_add(1);
        if summary.first_seen.is_none() {
            summary.first_seen = Some(now);
        }
        summary.last_seen = Some(now);
        self.summaries.insert(target.clone(), summary);

        self.reports.flush();
        self.summaries.flush();

        let used = env::storage_usage().saturating_sub(before);
        let cost = storage_cost(used);
        require!(
            deposit >= cost,
            format!(
                "attach at least {} yoctoNEAR for storage",
                cost.as_yoctonear()
            )
        );
        refund(&reporter, deposit.saturating_sub(cost));

        RegistryEvent::ReportAdded {
            target,
            reporter,
            category,
        }
        .emit();
    }

    /// Remove the caller's report about `target` and refund the storage it
    /// released.
    pub fn withdraw_report(&mut self, target: AccountId) {
        let reporter = env::predecessor_account_id();
        let before = env::storage_usage();

        let now_empty = match self.reports.get_mut(&target) {
            Some(inner) => {
                require!(inner.remove(&reporter).is_some(), "no report to withdraw");
                inner.flush();
                inner.is_empty()
            }
            None => env::panic_str("no report to withdraw"),
        };
        if now_empty {
            self.reports.remove(&target);
        }

        let mut summary = self.summaries.get(&target).cloned().unwrap_or_default();
        summary.reports = summary.reports.saturating_sub(1);
        if summary.reports == 0 {
            // Timestamps are not recomputed on partial withdrawals (that would
            // need a scan over all reports); they are cleared when none remain.
            summary.first_seen = None;
            summary.last_seen = None;
        }
        if summary.reports == 0 && !summary.rebutted {
            self.summaries.remove(&target);
        } else {
            self.summaries.insert(target.clone(), summary);
        }

        self.reports.flush();
        self.summaries.flush();

        let released = before.saturating_sub(env::storage_usage());
        refund(&reporter, storage_cost(released));

        RegistryEvent::ReportWithdrawn { target, reporter }.emit();
    }

    /// Store or replace the caller's rebuttal about reports against them.
    /// Attach at least 0.01 NEAR; storage growth is kept, the rest refunded
    /// (plus any storage released when the new note is shorter).
    #[payable]
    pub fn rebut(&mut self, note: String) {
        let target = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_DEPOSIT, "attach at least 0.01 NEAR");
        require_note(&note);

        let before = env::storage_usage();
        self.rebuttals.insert(
            target.clone(),
            Rebuttal {
                note,
                created_at: U64(env::block_timestamp()),
            },
        );
        let mut summary = self.summaries.get(&target).cloned().unwrap_or_default();
        summary.rebutted = true;
        self.summaries.insert(target.clone(), summary);

        self.rebuttals.flush();
        self.summaries.flush();

        let after = env::storage_usage();
        let to_refund = if after >= before {
            let cost = storage_cost(after.saturating_sub(before));
            require!(
                deposit >= cost,
                format!(
                    "attach at least {} yoctoNEAR for storage",
                    cost.as_yoctonear()
                )
            );
            deposit.saturating_sub(cost)
        } else {
            deposit.saturating_add(storage_cost(before.saturating_sub(after)))
        };
        refund(&target, to_refund);

        RegistryEvent::RebuttalAdded { target }.emit();
    }

    pub fn get_summary(&self, target: AccountId) -> Summary {
        self.summaries.get(&target).cloned().unwrap_or_default()
    }

    /// Reports about `target` in insertion order (until a withdrawal swaps
    /// the last entry into the removed slot). `limit` is capped at 100.
    pub fn get_reports(&self, target: AccountId, from_index: u32, limit: u32) -> Vec<Report> {
        let Some(inner) = self.reports.get(&target) else {
            return vec![];
        };
        inner
            .values()
            .skip(from_index as usize)
            .take(limit.min(MAX_PAGE) as usize)
            .cloned()
            .collect()
    }

    pub fn get_rebuttal(&self, target: AccountId) -> Option<Rebuttal> {
        self.rebuttals.get(&target).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::testing_env;

    fn ctx(who: &str, deposit: NearToken) {
        ctx_at(who, deposit, env::storage_usage());
    }

    /// `testing_env!` resets storage usage to the context's value, so carry it
    /// over explicitly between calls.
    fn ctx_at(who: &str, deposit: NearToken, storage_usage: u64) {
        testing_env!(
            VMContextBuilder::new()
                .predecessor_account_id(who.parse().unwrap())
                .attached_deposit(deposit)
                .block_timestamp(1_000)
                .storage_usage(storage_usage)
                .build()
        );
    }

    #[test]
    fn report_storage_is_measured_and_fully_released_on_withdraw() {
        let mut c = Contract::default();
        ctx("alice.near", MIN_DEPOSIT);
        let base = env::storage_usage();
        c.report(
            "bad.near".parse().unwrap(),
            Category::Drainer,
            Some("h".repeat(44)),
            "n".repeat(280),
        );
        let used = env::storage_usage() - base;
        // The 280-byte note and the inner map entry must be counted, which
        // only happens if the nested collection was flushed before measuring.
        assert!(used > 400, "measured only {used} bytes");
        let logs = get_logs();
        assert!(logs.iter().any(|l| l.starts_with("EVENT_JSON:")
            && l.contains("\"event\":\"report_added\"")
            && l.contains("\"category\":\"drainer\"")));

        ctx("alice.near", NearToken::from_yoctonear(0));
        c.withdraw_report("bad.near".parse().unwrap());
        assert_eq!(env::storage_usage(), base, "withdraw must free all bytes");
        assert_eq!(
            c.get_summary("bad.near".parse().unwrap()),
            Summary::default()
        );
        assert!(
            get_logs()
                .iter()
                .any(|l| l.contains("\"event\":\"report_withdrawn\""))
        );
    }

    #[test]
    fn partial_withdraw_keeps_timestamps_and_rebuttal_keeps_summary() {
        let mut c = Contract::default();
        let bad: AccountId = "bad.near".parse().unwrap();
        for who in ["a.near", "b.near"] {
            ctx(who, MIN_DEPOSIT);
            c.report(bad.clone(), Category::Scam, None, "x".into());
        }
        ctx("bad.near", MIN_DEPOSIT);
        c.rebut("no".into());
        ctx("a.near", NearToken::from_yoctonear(0));
        c.withdraw_report(bad.clone());
        let s = c.get_summary(bad.clone());
        assert_eq!((s.reports, s.rebutted), (1, true));
        assert_eq!(s.first_seen, Some(U64(1_000)));
        ctx("b.near", NearToken::from_yoctonear(0));
        c.withdraw_report(bad.clone());
        let s = c.get_summary(bad.clone());
        assert_eq!(
            s,
            Summary {
                reports: 0,
                first_seen: None,
                last_seen: None,
                rebutted: true
            }
        );
        assert!(c.get_reports(bad, 0, 10).is_empty());
    }

    #[test]
    #[should_panic(expected = "tx_hash exceeds 64 bytes")]
    fn long_tx_hash_rejected() {
        let mut c = Contract::default();
        ctx("alice.near", MIN_DEPOSIT);
        c.report(
            "bad.near".parse().unwrap(),
            Category::Other,
            Some("h".repeat(65)),
            "x".into(),
        );
    }
}
