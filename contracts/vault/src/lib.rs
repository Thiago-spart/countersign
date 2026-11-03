//! Countersign vault: holds one AI agent's funds (spec §5.1).
//!
//! The agent holds only a function-call key on the vault account (receiver =
//! the vault, methods = `pay` / `request_approval` / `report`), so agent
//! methods require `predecessor == current_account_id`. Owner methods require
//! `predecessor == owner_id`, a separate account controlled by the human.

pub mod events;
pub mod ext;
pub mod limits;
pub mod pay;
pub mod types;

use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, LookupSet};
use near_sdk::{AccountId, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near, require};

use crate::events::VaultEvent;
use crate::types::{DailyCount, StorageKey};
pub use crate::types::{Limits, PayOutcome, PendingPayment, Spent};

/// Maximum number of queued payments. The vault pays this storage itself, so
/// the cap stops a compromised agent from growing it without limit.
pub const MAX_PENDING: u32 = 50;
/// Maximum `memo` / `reason` length in bytes for queued payments.
pub const MAX_TEXT_BYTES: usize = 280;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    registry_id: AccountId,
    limits: Limits,
    paused: bool,
    trusted: LookupSet<AccountId>,
    spent_today: Spent,
    pending: IterableMap<u64, PendingPayment>,
    next_id: u64,
    /// Reports forwarded by `report` on `reports_today.day`.
    reports_today: DailyCount,
}

#[near]
impl Contract {
    /// Initialize the vault. Only the vault account itself can call this
    /// (batch it with the deploy). `limits: None` uses the defaults.
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, registry_id: AccountId, limits: Option<Limits>) -> Self {
        Self {
            owner_id,
            registry_id,
            limits: limits.unwrap_or_default(),
            paused: false,
            trusted: LookupSet::new(StorageKey::Trusted),
            spent_today: Spent::default(),
            pending: IterableMap::new(StorageKey::Pending),
            next_id: 0,
            reports_today: DailyCount::default(),
        }
    }

    // ---------------------------------------------------------------- agent

    /// Queue a payment for the owner's approval (agent key only). Rejected
    /// while paused, above `per_tx`, or when the queue is full.
    pub fn request_approval(
        &mut self,
        receiver: AccountId,
        amount: NearToken,
        memo: String,
        reason: String,
    ) -> PayOutcome {
        self.require_self();
        require!(memo.len() <= MAX_TEXT_BYTES, "memo exceeds 280 bytes");
        require!(reason.len() <= MAX_TEXT_BYTES, "reason exceeds 280 bytes");
        if self.paused {
            return self.reject(None, receiver, amount, "paused");
        }
        if amount > self.limits.per_tx {
            return self.reject(None, receiver, amount, "over per-tx cap");
        }
        self.enqueue(receiver, amount, memo, reason)
    }

    // ---------------------------------------------------------------- owner

    /// Pay a pending payment. Re-checks pause and the daily cap; if either
    /// fails it returns `Rejected` and the payment stays pending.
    /// Requires exactly 1 yoctoNEAR (a full-access key on the owner account).
    #[payable]
    pub fn approve(&mut self, id: U64) -> PromiseOrValue<PayOutcome> {
        self.require_owner_one_yocto();
        let Some(p) = self.pending.get(&id.0).cloned() else {
            env::panic_str("no such pending payment");
        };
        if self.paused {
            return PromiseOrValue::Value(self.reject(Some(id), p.receiver, p.amount, "paused"));
        }
        let now = env::block_timestamp();
        if let Err(reason) = limits::reserve(
            &mut self.spent_today,
            now,
            p.amount.as_yoctonear(),
            self.limits.daily.as_yoctonear(),
        ) {
            return PromiseOrValue::Value(self.reject(Some(id), p.receiver, p.amount, reason));
        }
        self.pending.remove(&id.0);
        VaultEvent::PaymentApproved {
            id,
            receiver: p.receiver.clone(),
            amount: p.amount,
        }
        .emit();
        self.send_payment(Some(id), p.receiver, p.amount, limits::day_of(now))
    }

    /// Remove a pending payment without paying it.
    pub fn deny(&mut self, id: U64) {
        self.require_owner();
        let Some(p) = self.pending.remove(&id.0) else {
            env::panic_str("no such pending payment");
        };
        VaultEvent::PaymentDenied {
            id,
            receiver: p.receiver,
            amount: p.amount,
        }
        .emit();
    }

    /// Kill switch: while paused, `pay`, `request_approval` and `approve` reject.
    pub fn pause(&mut self) {
        self.require_owner();
        self.paused = true;
        VaultEvent::Paused {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    /// Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn unpause(&mut self) {
        self.require_owner_one_yocto();
        self.paused = false;
        VaultEvent::Unpaused {
            by: env::predecessor_account_id(),
        }
        .emit();
    }

    /// Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn set_limits(&mut self, limits: Limits) {
        self.require_owner_one_yocto();
        self.limits = limits;
    }

    /// Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn trust(&mut self, account_id: AccountId) {
        self.require_owner_one_yocto();
        self.trusted.insert(account_id);
    }

    /// Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn untrust(&mut self, account_id: AccountId) {
        self.require_owner_one_yocto();
        self.trusted.remove(&account_id);
    }

    /// Send `amount` from the vault to the owner. The storage stake stays
    /// locked. Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        self.require_owner_one_yocto();
        require!(!amount.is_zero(), "amount must be positive");
        let storage_stake =
            env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let available = env::account_balance().saturating_sub(storage_stake);
        require!(amount <= available, "insufficient available balance");
        Promise::new(self.owner_id.clone()).transfer(amount)
    }

    // ---------------------------------------------------------------- views

    pub fn get_limits(&self) -> Limits {
        self.limits.clone()
    }

    pub fn get_pending(&self) -> Vec<PendingPayment> {
        self.pending.values().cloned().collect()
    }

    /// Amount spent (or reserved) today, UTC. Zero once the day has rolled over.
    pub fn get_spent_today(&self) -> NearToken {
        let today = limits::day_of(env::block_timestamp());
        if self.spent_today.day == today {
            NearToken::from_yoctonear(self.spent_today.amount)
        } else {
            NearToken::from_yoctonear(0)
        }
    }

    pub fn is_trusted(&self, account_id: AccountId) -> bool {
        self.trusted.contains(&account_id)
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

impl Contract {
    fn require_self(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the vault itself can call this"
        );
    }

    fn require_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the owner can call this"
        );
    }

    /// Owner gate for methods that loosen controls or move funds: also
    /// requires exactly 1 yoctoNEAR, which only a full-access key can attach.
    fn require_owner_one_yocto(&self) {
        self.require_owner();
        near_sdk::assert_one_yocto();
    }

    /// Emit `payment_rejected` and build the `Rejected` outcome.
    fn reject(
        &self,
        id: Option<U64>,
        receiver: AccountId,
        amount: NearToken,
        reason: &str,
    ) -> PayOutcome {
        VaultEvent::PaymentRejected {
            id,
            receiver,
            amount,
            reason: reason.to_string(),
        }
        .emit();
        PayOutcome::Rejected {
            reason: reason.to_string(),
        }
    }

    /// Add a payment to the pending queue, or reject it if the queue is full.
    /// Never panics, so `pay`'s callback (Task 3) can use it too.
    fn enqueue(
        &mut self,
        receiver: AccountId,
        amount: NearToken,
        memo: String,
        reason: String,
    ) -> PayOutcome {
        if self.pending.len() >= MAX_PENDING {
            return self.reject(None, receiver, amount, "pending queue full");
        }
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.pending.insert(
            id,
            PendingPayment {
                id: U64(id),
                receiver: receiver.clone(),
                amount,
                memo,
                reason: reason.clone(),
                created_at: U64(env::block_timestamp()),
            },
        );
        VaultEvent::PaymentPending {
            id: U64(id),
            receiver,
            amount,
            reason: reason.clone(),
        }
        .emit();
        PayOutcome::Pending {
            id: U64(id),
            reason,
        }
    }
}
