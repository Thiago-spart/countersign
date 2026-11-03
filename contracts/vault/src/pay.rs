//! `pay()` with the shared registry check (spec §5.1.1), the transfer
//! callback shared with `approve`, and `report()` forwarding.
//!
//! Callbacks are `#[private]` and never panic: every non-paid branch
//! releases the reservation made by `pay` / `approve` / `report`.

use near_sdk::json_types::U64;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, near, require,
};

use crate::events::VaultEvent;
use crate::ext::{CATEGORIES, Summary, ext_registry};
use crate::types::DailyCount;
use crate::{Contract, ContractExt, MAX_TEXT_BYTES, PayOutcome, limits};

/// Static gas for the registry's `get_summary` view (a single map read).
pub const GAS_GET_SUMMARY: Gas = Gas::from_tgas(5);
/// Static gas for `on_registry_summary`; covers creating the transfer and
/// the `on_transfer_done` callback (`GAS_ON_TRANSFER_DONE`).
pub const GAS_ON_REGISTRY_SUMMARY: Gas = Gas::from_tgas(25);
/// Static gas for `on_transfer_done`.
pub const GAS_ON_TRANSFER_DONE: Gas = Gas::from_tgas(10);
/// Static gas for the registry's `report` (storage writes + a refund transfer).
pub const GAS_REGISTRY_REPORT: Gas = Gas::from_tgas(15);
/// Static gas for `on_report_done`.
pub const GAS_ON_REPORT_DONE: Gas = Gas::from_tgas(5);

/// Deposit forwarded with each report (the registry's minimum; it keeps the
/// measured storage cost and refunds the rest to the vault).
pub const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Reports the agent may forward per UTC day.
pub const MAX_REPORTS_PER_DAY: u32 = 5;
/// Same limit the registry enforces; checked here to fail fast.
pub const MAX_TX_HASH_BYTES: usize = 64;

pub const TRANSFER_FAILED: &str = "transfer failed";

#[near]
impl Contract {
    /// Pay `receiver` from the vault (agent key only), in the order of spec
    /// §5.1.1: pause, per-tx cap, reserve against the daily cap, then the
    /// registry check in `on_registry_summary`. Returns `Paid`, `Pending`,
    /// `Rejected` or `Failed` (the transfer itself failed).
    pub fn pay(
        &mut self,
        receiver: AccountId,
        amount: NearToken,
        memo: String,
    ) -> PromiseOrValue<PayOutcome> {
        self.require_self();
        // Checked before reserving: the callback may queue the memo and must
        // not panic.
        require!(memo.len() <= MAX_TEXT_BYTES, "memo exceeds 280 bytes");
        if self.paused {
            return PromiseOrValue::Value(self.reject(None, receiver, amount, "paused"));
        }
        if amount > self.limits.per_tx {
            return PromiseOrValue::Value(self.reject(None, receiver, amount, "over per-tx cap"));
        }
        let now = env::block_timestamp();
        if let Err(reason) = limits::reserve(
            &mut self.spent_today,
            now,
            amount.as_yoctonear(),
            self.limits.daily.as_yoctonear(),
        ) {
            return PromiseOrValue::Value(self.reject(None, receiver, amount, reason));
        }
        ext_registry::ext(self.registry_id.clone())
            .with_static_gas(GAS_GET_SUMMARY)
            .get_summary(receiver.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REGISTRY_SUMMARY)
                    .on_registry_summary(receiver, amount, memo, limits::day_of(now)),
            )
            .into()
    }

    /// Report `target` to the registry as this vault (agent key only).
    /// Forwards `REPORT_DEPOSIT`, which counts against `daily` and is released
    /// if the registry refuses the report. At most 5 forwards per UTC day
    /// (attempts count, even if the registry then refuses).
    pub fn report(
        &mut self,
        target: AccountId,
        category: String,
        tx_hash: Option<String>,
        note: String,
    ) -> Promise {
        self.require_self();
        require!(CATEGORIES.contains(&category.as_str()), "invalid category");
        require!(note.len() <= MAX_TEXT_BYTES, "note exceeds 280 bytes");
        if let Some(h) = &tx_hash {
            require!(h.len() <= MAX_TX_HASH_BYTES, "tx_hash exceeds 64 bytes");
        }
        let now = env::block_timestamp();
        let today = limits::day_of(now);
        let used = if self.reports_today.day == today {
            self.reports_today.count
        } else {
            0
        };
        require!(used < MAX_REPORTS_PER_DAY, "daily report limit reached");
        if let Err(reason) = limits::reserve(
            &mut self.spent_today,
            now,
            REPORT_DEPOSIT.as_yoctonear(),
            self.limits.daily.as_yoctonear(),
        ) {
            env::panic_str(reason);
        }
        self.reports_today = DailyCount {
            day: today,
            count: used.saturating_add(1),
        };
        ext_registry::ext(self.registry_id.clone())
            .with_static_gas(GAS_REGISTRY_REPORT)
            .with_attached_deposit(REPORT_DEPOSIT)
            .report(target.clone(), category.clone(), tx_hash, note)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REPORT_DONE)
                    .on_report_done(target, category, today),
            )
    }

    // ------------------------------------------------------------ callbacks

    #[private]
    pub fn on_registry_summary(
        &mut self,
        receiver: AccountId,
        amount: NearToken,
        memo: String,
        reserved_day: u64,
        #[callback_result] r: Result<Summary, PromiseError>,
    ) -> PromiseOrValue<PayOutcome> {
        let Ok(summary) = r else {
            self.release(reserved_day, amount);
            return PromiseOrValue::Value(self.reject(
                None,
                receiver,
                amount,
                "registry unavailable",
            ));
        };
        // Rebuttals do not bypass this: a scammer can rebut their own reports.
        if summary.reports >= self.limits.registry_pending_threshold {
            self.release(reserved_day, amount);
            return PromiseOrValue::Value(self.enqueue(
                receiver,
                amount,
                memo,
                "registry_flagged".to_string(),
            ));
        }
        if !self.trusted.contains(&receiver) && amount > self.limits.unknown_payee_max {
            self.release(reserved_day, amount);
            return PromiseOrValue::Value(self.enqueue(
                receiver,
                amount,
                memo,
                "unknown payee".to_string(),
            ));
        }
        self.send_payment(None, receiver, amount, reserved_day)
    }

    /// Result of the transfer sent by `pay` or `approve`. On failure the
    /// reservation is released; an approved payment is not re-queued.
    #[private]
    pub fn on_transfer_done(
        &mut self,
        id: Option<U64>,
        receiver: AccountId,
        amount: NearToken,
        reserved_day: u64,
        #[callback_result] r: Result<(), PromiseError>,
    ) -> PayOutcome {
        if r.is_err() {
            self.release(reserved_day, amount);
            VaultEvent::PaymentFailed {
                id,
                receiver,
                amount,
                reason: TRANSFER_FAILED.to_string(),
            }
            .emit();
            return PayOutcome::Failed {
                reason: TRANSFER_FAILED.to_string(),
            };
        }
        VaultEvent::PaymentPaid {
            id,
            receiver: receiver.clone(),
            amount,
        }
        .emit();
        PayOutcome::Paid { receiver, amount }
    }

    /// Result of a forwarded report. Returns whether it landed.
    #[private]
    pub fn on_report_done(
        &mut self,
        target: AccountId,
        category: String,
        reserved_day: u64,
        #[callback_result] r: Result<(), PromiseError>,
    ) -> bool {
        if r.is_err() {
            // The registry panicked, so the deposit came back with the refund.
            self.release(reserved_day, REPORT_DEPOSIT);
            env::log_str("registry refused the report; deposit released");
            return false;
        }
        VaultEvent::ReportForwarded {
            target,
            category,
            deposit: REPORT_DEPOSIT,
        }
        .emit();
        true
    }
}

impl Contract {
    /// Undo a reservation made on `reserved_day` (no-op after rollover).
    fn release(&mut self, reserved_day: u64, amount: NearToken) {
        limits::release(&mut self.spent_today, reserved_day, amount.as_yoctonear());
    }

    /// The single place a reserved payment is sent (`pay` and `approve`):
    /// transfer, then `on_transfer_done`, which emits `payment_paid` or
    /// releases the reservation and emits `payment_failed`.
    pub(crate) fn send_payment(
        &mut self,
        id: Option<U64>,
        receiver: AccountId,
        amount: NearToken,
        reserved_day: u64,
    ) -> PromiseOrValue<PayOutcome> {
        Promise::new(receiver.clone())
            .transfer(amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_TRANSFER_DONE)
                    .on_transfer_done(id, receiver, amount, reserved_day),
            )
            .into()
    }
}
