use near_sdk::{AccountId, near};

use crate::types::Category;

/// NEP-297 events, logged as `EVENT_JSON:{"standard":"countersign_registry",...}`.
#[near(event_json(standard = "countersign_registry"))]
pub enum RegistryEvent {
    #[event_version("1.0.0")]
    ReportAdded {
        target: AccountId,
        reporter: AccountId,
        category: Category,
    },
    #[event_version("1.0.0")]
    ReportWithdrawn {
        target: AccountId,
        reporter: AccountId,
    },
    #[event_version("1.0.0")]
    RebuttalAdded { target: AccountId },
}
