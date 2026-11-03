use near_sdk::json_types::U64;
use near_sdk::{AccountId, NearToken, near};

/// NEP-297 events, logged as `EVENT_JSON:{"standard":"countersign","version":"1.0.0",...}`.
#[near(event_json(standard = "countersign"))]
pub enum VaultEvent {
    /// A payment was queued for the owner's approval.
    #[event_version("1.0.0")]
    PaymentPending {
        id: U64,
        receiver: AccountId,
        amount: NearToken,
        reason: String,
    },
    /// A payment was refused without being queued or sent.
    /// `id` is set when an `approve` was refused (the payment stays pending).
    #[event_version("1.0.0")]
    PaymentRejected {
        id: Option<U64>,
        receiver: AccountId,
        amount: NearToken,
        reason: String,
    },
    /// The owner approved a pending payment.
    #[event_version("1.0.0")]
    PaymentApproved {
        id: U64,
        receiver: AccountId,
        amount: NearToken,
    },
    /// A transfer was sent. `id` is set for approved payments.
    #[event_version("1.0.0")]
    PaymentPaid {
        id: Option<U64>,
        receiver: AccountId,
        amount: NearToken,
    },
    /// The owner denied (removed) a pending payment.
    #[event_version("1.0.0")]
    PaymentDenied {
        id: U64,
        receiver: AccountId,
        amount: NearToken,
    },
    #[event_version("1.0.0")]
    Paused { by: AccountId },
    #[event_version("1.0.0")]
    Unpaused { by: AccountId },
}
