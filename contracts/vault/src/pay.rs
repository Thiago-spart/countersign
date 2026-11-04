//! `pay()` with the shared registry check (spec §5.1.1), the transfer
//! callback shared with `approve`, and `report()` forwarding.
//!
//! Callbacks are `#[private]` and never panic: every non-paid branch
//! releases the reservation made by `pay` / `approve` / `report`.

use near_sdk::json_types::U64;
use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, near, require,
    serde_json,
};

use crate::events::VaultEvent;
use crate::ext::{CATEGORIES, Summary, ext_registry};
use crate::types::DailyCount;
use crate::{
    AMOUNT_NOT_POSITIVE, Contract, ContractExt, MAX_TEXT_BYTES, PayOutcome, available_balance,
    limits,
};

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
pub const GAS_ON_REPORT_DONE: Gas = Gas::from_tgas(10);

/// Least prepaid gas `pay` accepts: the callbacks' static gas (5 + 25) plus
/// 10 TGas for `pay`'s own execution (measured: a whole paid `pay` burns
/// ~8.4 TGas across all its receipts). Below this a callback could run out
/// of gas and strand the reservation. The SDK attaches 50 TGas.
pub const MIN_PAY_GAS: Gas = Gas::from_tgas(40);
/// Least prepaid gas `report` accepts: 15 + 10 static plus 10 for itself.
pub const MIN_REPORT_GAS: Gas = Gas::from_tgas(35);
/// Largest `get_summary` response read (the real one is ~100 bytes).
pub const MAX_SUMMARY_BYTES: usize = 1024;

/// Deposit forwarded with each report (the registry's minimum; it keeps the
/// measured storage cost and refunds the rest to the vault).
pub const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);
/// Reports the agent may forward per UTC day.
pub const MAX_REPORTS_PER_DAY: u32 = 5;
/// Same limit the registry enforces; checked here to fail fast.
pub const MAX_TX_HASH_BYTES: usize = 64;

pub const TRANSFER_FAILED: &str = "transfer failed";
pub const INSUFFICIENT_BALANCE: &str = "insufficient balance";
/// Outcome of a callback invoked without exactly one promise result (i.e.
/// called directly rather than by `.then`). Nothing is released or sent.
pub const NOT_A_CALLBACK: &str = "not called as a callback";
/// Bytes read from a transfer / report result (both are empty in practice;
/// only success vs failure matters).
pub const MAX_EMPTY_RESULT_BYTES: usize = 64;

/// Parse a `get_summary` response; `None` if it is not a registry summary.
pub fn parse_summary(bytes: &[u8]) -> Option<Summary> {
    serde_json::from_slice(bytes).ok()
}

#[near]
impl Contract {
    /// Pay `receiver` from the vault (agent key only). Checks, in order: at
    /// least 40 TGas and a memo of at most 280 bytes (panics), then zero
    /// amount, pause, per-tx cap and free balance (`Rejected`), then reserves
    /// against the daily cap; a second pause check, the registry check,
    /// unknown-payee cap and a second balance check run in
    /// `on_registry_summary`. Returns `Paid`,
    /// `Pending`, `Rejected` or `Failed` (the transfer itself failed).
    pub fn pay(
        &mut self,
        receiver: AccountId,
        amount: NearToken,
        memo: String,
    ) -> PromiseOrValue<PayOutcome> {
        self.require_self();
        require!(env::prepaid_gas() >= MIN_PAY_GAS, "not enough gas");
        // Checked before reserving: the callback may queue the memo and must
        // not panic.
        require!(memo.len() <= MAX_TEXT_BYTES, "memo exceeds 280 bytes");
        if amount.is_zero() {
            return PromiseOrValue::Value(self.reject(None, receiver, amount, AMOUNT_NOT_POSITIVE));
        }
        if self.paused {
            return PromiseOrValue::Value(self.reject(None, receiver, amount, "paused"));
        }
        if amount > self.limits.per_tx {
            return PromiseOrValue::Value(self.reject(None, receiver, amount, "over per-tx cap"));
        }
        if amount > available_balance() {
            return PromiseOrValue::Value(self.reject(
                None,
                receiver,
                amount,
                INSUFFICIENT_BALANCE,
            ));
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
        require!(env::prepaid_gas() >= MIN_REPORT_GAS, "not enough gas");
        require!(!self.paused, "paused");
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
    ) -> PromiseOrValue<PayOutcome> {
        // The agent signs as the vault, so `#[private]` alone doesn't tell a
        // `.then` apart from a direct call (the key's method list does). A
        // direct call has no promise result: release nothing, send nothing.
        if env::promise_results_count() != 1 {
            return PromiseOrValue::Value(PayOutcome::Rejected {
                reason: NOT_A_CALLBACK.to_string(),
            });
        }
        // The owner may have paused while the registry read was in flight.
        // Reject rather than queue: a queued payment would outlive the pause.
        if self.paused {
            self.release(reserved_day, amount);
            return PromiseOrValue::Value(self.reject(None, receiver, amount, "paused"));
        }
        // Read the result by hand: `#[callback_result]` would panic on a
        // malformed response, stranding the reservation.
        let summary = env::promise_result_checked(0, MAX_SUMMARY_BYTES)
            .ok()
            .and_then(|b| parse_summary(&b));
        let Some(summary) = summary else {
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
        // The balance can drop between `pay` and here (gas, other payments);
        // a transfer the vault can't afford would panic and strand the
        // reservation.
        if amount > available_balance() {
            self.release(reserved_day, amount);
            return PromiseOrValue::Value(self.reject(
                None,
                receiver,
                amount,
                INSUFFICIENT_BALANCE,
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
    ) -> PayOutcome {
        // See `on_registry_summary`. The result is read by hand so unexpected
        // data can't make this callback panic.
        if env::promise_results_count() != 1 {
            return PayOutcome::Failed {
                reason: NOT_A_CALLBACK.to_string(),
            };
        }
        // Only a failed promise counts as failed; an oversized (TooLong) result
        // still means the call succeeded.
        if matches!(
            env::promise_result_checked(0, MAX_EMPTY_RESULT_BYTES),
            Err(PromiseError::Failed)
        ) {
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
    ) -> bool {
        // See `on_registry_summary` and `on_transfer_done`.
        if env::promise_results_count() != 1 {
            env::log_str(NOT_A_CALLBACK);
            return false;
        }
        // Only a failed promise counts as failed; an oversized (TooLong) result
        // still means the call succeeded.
        if matches!(
            env::promise_result_checked(0, MAX_EMPTY_RESULT_BYTES),
            Err(PromiseError::Failed)
        ) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Limits;
    use near_sdk::test_utils::{VMContextBuilder, get_logs};
    use near_sdk::{PromiseResult, testing_env};

    fn vault() -> AccountId {
        "vault.near".parse().unwrap()
    }

    #[test]
    fn parse_summary_accepts_registry_shape_only() {
        let ok = br#"{"reports":2,"first_seen":"1","last_seen":"2","rebutted":true}"#;
        assert_eq!(parse_summary(ok).map(|s| s.reports), Some(2));
        for bad in [
            &b""[..],
            b"null",
            b"42",
            br#"{"reports":"two"}"#,
            br#"["x"]"#,
            b"\xff",
        ] {
            assert!(parse_summary(bad).is_none(), "{bad:?}");
        }
    }

    /// A malformed registry response is treated like a failed call:
    /// released + `Rejected("registry unavailable")`, no panic.
    #[test]
    fn malformed_summary_rejects_and_releases() {
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .account_balance(NearToken::from_near(10))
            .block_timestamp(1_000)
            .build();
        testing_env!(ctx.clone());
        let mut c = Contract::new(
            "owner.near".parse().unwrap(),
            "registry.near".parse().unwrap(),
            Some(Limits::default()),
        );
        let amount = NearToken::from_millinear(100);
        limits::reserve(&mut c.spent_today, 1_000, amount.as_yoctonear(), u128::MAX).unwrap();
        assert_eq!(c.get_spent_today(), amount);

        testing_env!(
            ctx,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(b"\"not a summary\"".to_vec())],
        );
        let out = c.on_registry_summary("bob.near".parse().unwrap(), amount, "m".into(), 0);
        let PromiseOrValue::Value(out) = out else {
            panic!("expected a value")
        };
        assert_eq!(
            out,
            PayOutcome::Rejected {
                reason: "registry unavailable".into()
            }
        );
        assert_eq!(c.get_spent_today(), NearToken::from_yoctonear(0));
        assert!(get_logs().iter().any(|l| l.contains("payment_rejected")));
    }

    /// Callbacks called directly (no promise result), e.g. by a key that can
    /// sign as the vault: nothing is released, nothing is sent, no panic.
    #[test]
    fn callbacks_without_a_promise_result_change_nothing() {
        let ctx = VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .account_balance(NearToken::from_near(10))
            .block_timestamp(1_000)
            .build();
        testing_env!(ctx);
        let mut c = Contract::new(
            "owner.near".parse().unwrap(),
            "registry.near".parse().unwrap(),
            None,
        );
        let amount = NearToken::from_millinear(100);
        limits::reserve(&mut c.spent_today, 1_000, amount.as_yoctonear(), u128::MAX).unwrap();
        let bob: AccountId = "bob.near".parse().unwrap();
        assert_eq!(env::promise_results_count(), 0);

        let out = c.on_registry_summary(bob.clone(), amount, "m".into(), 0);
        let PromiseOrValue::Value(out) = out else {
            panic!("must not create a promise")
        };
        assert_eq!(
            out,
            PayOutcome::Rejected {
                reason: NOT_A_CALLBACK.into()
            }
        );
        assert_eq!(c.get_spent_today(), amount, "on_registry_summary released");

        assert_eq!(
            c.on_transfer_done(None, bob.clone(), amount, 0),
            PayOutcome::Failed {
                reason: NOT_A_CALLBACK.into()
            }
        );
        assert_eq!(c.get_spent_today(), amount, "on_transfer_done released");

        assert!(!c.on_report_done(bob, "scam".into(), 0));
        assert_eq!(c.get_spent_today(), amount, "on_report_done released");
        assert!(c.get_pending().is_empty());
        assert!(
            !get_logs().iter().any(|l| l.starts_with("EVENT_JSON:")),
            "no events: {:?}",
            get_logs()
        );
    }

    const NOW: u64 = 1_000;

    fn owner() -> AccountId {
        "owner.near".parse().unwrap()
    }

    fn bob() -> AccountId {
        "bob.near".parse().unwrap()
    }

    fn ctx_as(predecessor: AccountId) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(predecessor)
            .account_balance(NearToken::from_near(10))
            .block_timestamp(NOW)
            .prepaid_gas(Gas::from_tgas(300))
            .build()
    }

    /// `pay` as the agent (reserves `amount`, starts the registry read);
    /// then, if `pause`, the owner pauses before the summary arrives.
    fn pay_then(pause: bool, amount: NearToken) -> Contract {
        testing_env!(ctx_as(vault()));
        let mut c = Contract::new(owner(), "registry.near".parse().unwrap(), None);
        let out = c.pay(bob(), amount, "m".into());
        assert!(
            matches!(out, PromiseOrValue::Promise(_)),
            "pay must call the registry"
        );
        assert_eq!(c.get_spent_today(), amount);
        if pause {
            testing_env!(ctx_as(owner()));
            c.pause();
        }
        c
    }

    /// Deliver `result` to `on_registry_summary` as the vault's own callback.
    fn summary_arrives(
        c: &mut Contract,
        result: PromiseResult,
        amount: NearToken,
    ) -> PromiseOrValue<PayOutcome> {
        testing_env!(
            ctx_as(vault()),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result],
        );
        c.on_registry_summary(bob(), amount, "m".into(), limits::day_of(NOW))
    }

    fn summary(reports: u32) -> PromiseResult {
        PromiseResult::Successful(
            format!(r#"{{"reports":{reports},"first_seen":"1","last_seen":"2","rebutted":false}}"#)
                .into_bytes(),
        )
    }

    fn assert_paused_rejection(c: &Contract, out: PromiseOrValue<PayOutcome>) {
        let PromiseOrValue::Value(out) = out else {
            panic!("paused: must not schedule a transfer")
        };
        assert_eq!(
            out,
            PayOutcome::Rejected {
                reason: "paused".into()
            }
        );
        assert_eq!(
            c.get_spent_today(),
            NearToken::from_yoctonear(0),
            "not released"
        );
        assert!(c.get_pending().is_empty(), "paused: must not enqueue");
        assert!(get_logs().iter().any(|l| l.contains("payment_rejected")));
    }

    /// Owner pauses while the registry read is in flight: a clean summary
    /// must not lead to a transfer.
    #[test]
    fn pause_during_registry_read_rejects_clean_payment() {
        let amount = NearToken::from_millinear(50);
        let mut c = pay_then(true, amount);
        let out = summary_arrives(&mut c, summary(0), amount);
        assert_paused_rejection(&c, out);
    }

    /// Paused with a flagged receiver or an over-cap unknown payee: rejected,
    /// not queued (approving later would bypass the pause decision).
    #[test]
    fn pause_during_registry_read_does_not_enqueue() {
        let mut c = pay_then(true, NearToken::from_millinear(50));
        let out = summary_arrives(&mut c, summary(5), NearToken::from_millinear(50));
        assert_paused_rejection(&c, out);

        let big = NearToken::from_millinear(500);
        let mut c = pay_then(true, big);
        let out = summary_arrives(&mut c, summary(0), big);
        assert_paused_rejection(&c, out);
    }

    /// Paused and the registry call failed: still released, reason `paused`.
    #[test]
    fn pause_during_registry_read_with_failed_registry() {
        let amount = NearToken::from_millinear(50);
        let mut c = pay_then(true, amount);
        let out = summary_arrives(&mut c, PromiseResult::Failed, amount);
        assert_paused_rejection(&c, out);
    }

    /// Unpaused behaviour is unchanged: clean → transfer, flagged → queued.
    #[test]
    fn unpaused_summary_still_pays_or_queues() {
        let amount = NearToken::from_millinear(50);
        let mut c = pay_then(false, amount);
        let out = summary_arrives(&mut c, summary(0), amount);
        assert!(
            matches!(out, PromiseOrValue::Promise(_)),
            "expected a transfer"
        );
        assert_eq!(c.get_spent_today(), amount, "reservation kept until paid");

        let mut c = pay_then(false, amount);
        let PromiseOrValue::Value(out) = summary_arrives(&mut c, summary(5), amount) else {
            panic!("flagged: expected a value")
        };
        assert!(matches!(out, PayOutcome::Pending { .. }), "{out:?}");
        assert_eq!(c.get_pending().len(), 1);
        assert_eq!(c.get_spent_today(), NearToken::from_yoctonear(0));
    }
}
