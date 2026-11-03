//! Sandbox integration tests for `pay()` with the registry check, the
//! transfer callbacks and `report()` (Task 3, issue #5).
//!
//! The registry is deployed from `contracts/res/registry.wasm`
//! (`pnpm build:contracts`); the vault is built fresh from this crate.

mod common;

use common::*;
use near_api::types::AccessKeyPermission;
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::serde_json::{Value, json};

const MILLI: fn(u128) -> NearToken = NearToken::from_millinear;
const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);
const ZERO: NearToken = NearToken::from_yoctonear(0);

fn paid(receiver: &AccountId, amount: NearToken) -> Value {
    json!({"status": "paid", "receiver": receiver, "amount": amount})
}

fn failed(reason: &str) -> Value {
    json!({"status": "failed", "reason": reason})
}

impl Env {
    async fn pay(&self, receiver: &AccountId, amount: NearToken) -> R<TxResult> {
        self.agent_call(
            "pay",
            json!({"receiver": receiver, "amount": amount, "memo": "invoice 7"}),
        )
        .await
    }

    async fn pay_json(&self, receiver: &AccountId, amount: NearToken) -> R<Value> {
        Ok(self.pay(receiver, amount).await?.assert_success().json()?)
    }

    async fn trust(&self, who: &AccountId) -> R {
        self.owner_call("trust", json!({"account_id": who}))
            .await?
            .assert_success();
        Ok(())
    }

    /// `reporter` files a report about `target` directly with the registry.
    async fn registry_report(&self, reporter: &AccountId, target: &AccountId) -> R {
        self.registry_call(
            reporter,
            "report",
            json!({"target": target, "category": "scam", "tx_hash": null, "note": "took my money"}),
            REPORT_DEPOSIT,
        )
        .await?
        .assert_success();
        Ok(())
    }

    async fn agent_report(&self, target: &str, category: &str) -> R<TxResult> {
        self.agent_call(
            "report",
            json!({"target": target, "category": category, "tx_hash": null,
                   "note": "prompt-injected payment request"}),
        )
        .await
    }

    async fn agent_allowance(&self) -> R<NearToken> {
        let key = near_api::Account(self.vault.clone())
            .access_key(self.agent.get_public_key().await?)
            .fetch_from(&self.net)
            .await?
            .data;
        match key.permission {
            AccessKeyPermission::FunctionCall(p) => Ok(p.allowance.expect("allowance set")),
            AccessKeyPermission::FullAccess => panic!("agent key must be a function-call key"),
        }
    }
}

#[tokio::test]
async fn pay_trusted_small_paid() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    env.trust(&bob).await?;
    let before = env.balance(&bob).await?;
    let res = env.pay(&bob, MILLI(500)).await?.assert_success();
    let ev = events(&res.logs(), "payment_paid");
    assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
    assert_eq!(ev[0]["data"]["id"], Value::Null);
    assert_eq!(ev[0]["data"]["receiver"], json!(bob));
    assert_eq!(ev[0]["data"]["amount"], json!(MILLI(500)));
    assert_eq!(res.json::<Value>()?, paid(&bob, MILLI(500)));
    assert_eq!(env.balance(&bob).await?, before.saturating_add(MILLI(500)));
    assert_eq!(env.spent_today().await?, MILLI(500));
    Ok(())
}

#[tokio::test]
async fn pay_unknown_under_limit_paid() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    let before = env.balance(&bob).await?;
    assert_eq!(
        env.pay_json(&bob, MILLI(100)).await?,
        paid(&bob, MILLI(100))
    );
    assert_eq!(env.balance(&bob).await?, before.saturating_add(MILLI(100)));
    assert_eq!(env.spent_today().await?, MILLI(100));
    Ok(())
}

#[tokio::test]
async fn pay_unknown_over_limit_pending() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    let before = env.balance(&bob).await?;
    let res = env.pay(&bob, MILLI(200)).await?.assert_success();
    assert_eq!(events(&res.logs(), "payment_pending").len(), 1);
    assert!(events(&res.logs(), "payment_paid").is_empty());
    let outcome: Value = res.json()?;
    let id = pending_id(&outcome);
    assert_eq!(outcome["reason"], "unknown payee");
    assert_eq!(env.spent_today().await?, ZERO);
    assert_eq!(env.balance(&bob).await?, before);
    let pending = env.pending().await?;
    assert_eq!(pending.len(), 1);
    let p = &pending[0];
    assert_eq!((p.id, &p.receiver, p.amount), (id, &bob, MILLI(200)));
    assert_eq!(
        (p.memo.as_str(), p.reason.as_str()),
        ("invoice 7", "unknown payee")
    );
    Ok(())
}

#[tokio::test]
async fn pay_registry_flagged_pending() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    let (r1, r2) = (env.account("r1").await?, env.account("r2").await?);
    env.trust(&bob).await?;

    // One report is under the threshold (2): still paid.
    env.registry_report(&r1, &bob).await?;
    assert_eq!(env.pay_json(&bob, MILLI(50)).await?, paid(&bob, MILLI(50)));

    // Two reports: queued even though bob is trusted.
    env.registry_report(&r2, &bob).await?;
    let before = env.balance(&bob).await?;
    let outcome = env.pay_json(&bob, MILLI(50)).await?;
    pending_id(&outcome);
    assert_eq!(outcome["reason"], "registry_flagged");
    assert_eq!(env.balance(&bob).await?, before);
    assert_eq!(env.spent_today().await?, MILLI(50));
    Ok(())
}

#[tokio::test]
async fn self_rebuttal_does_not_bypass() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    let (r1, r2) = (env.account("r1").await?, env.account("r2").await?);
    env.registry_report(&r1, &bob).await?;
    env.registry_report(&r2, &bob).await?;
    env.registry_call(
        &bob,
        "rebut",
        json!({"note": "those reports are lies"}),
        REPORT_DEPOSIT,
    )
    .await?
    .assert_success();
    let summary: Value = env
        .registry_view("get_summary", json!({"target": bob}))
        .await?;
    assert_eq!(
        (summary["reports"].clone(), summary["rebutted"].clone()),
        (json!(2), json!(true))
    );

    let outcome = env.pay_json(&bob, MILLI(50)).await?;
    pending_id(&outcome);
    assert_eq!(outcome["reason"], "registry_flagged");
    assert_eq!(env.spent_today().await?, ZERO);
    Ok(())
}

#[tokio::test]
async fn pay_over_per_tx_rejected() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    env.trust(&bob).await?;
    let before = env.balance(&bob).await?;
    let res = env.pay(&bob, MILLI(1500)).await?.assert_success();
    let ev = events(&res.logs(), "payment_rejected");
    assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
    assert_eq!(ev[0]["data"]["reason"], "over per-tx cap");
    assert_eq!(res.json::<Value>()?, rejected("over per-tx cap"));
    assert_eq!(env.balance(&bob).await?, before);
    assert_eq!(env.spent_today().await?, ZERO);
    Ok(())
}

#[tokio::test]
async fn pay_paused_rejected() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    env.trust(&bob).await?;
    env.owner_call("pause", json!({})).await?.assert_success();
    let before = env.balance(&bob).await?;
    assert_eq!(env.pay_json(&bob, MILLI(100)).await?, rejected("paused"));
    assert_eq!(env.balance(&bob).await?, before);
    assert_eq!(env.spent_today().await?, ZERO);
    env.owner_call("unpause", json!({})).await?.assert_success();
    assert_eq!(
        env.pay_json(&bob, MILLI(100)).await?,
        paid(&bob, MILLI(100))
    );
    Ok(())
}

#[tokio::test]
async fn pay_memo_capped_at_280_bytes() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    let res = env
        .agent_call(
            "pay",
            json!({"receiver": bob, "amount": MILLI(200), "memo": "x".repeat(281)}),
        )
        .await?;
    fails_with(res, "memo exceeds 280 bytes");
    assert_eq!(env.spent_today().await?, ZERO);
    assert!(env.pending().await?.is_empty());
    // 280 bytes is fine (and survives into the pending entry).
    let outcome: Value = env
        .agent_call(
            "pay",
            json!({"receiver": bob, "amount": MILLI(200), "memo": "x".repeat(280)}),
        )
        .await?
        .assert_success()
        .json()?;
    pending_id(&outcome);
    assert_eq!(env.pending().await?[0].memo.len(), 280);
    Ok(())
}

#[tokio::test]
async fn agent_methods_require_self_predecessor() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    fails_with(
        env.call(
            &bob,
            "pay",
            json!({"receiver": bob, "amount": MILLI(10), "memo": ""}),
        )
        .await?,
        NOT_SELF,
    );
    fails_with(
        env.owner_call(
            "report",
            json!({"target": "bad.sandbox", "category": "scam", "tx_hash": null, "note": ""}),
        )
        .await?,
        NOT_SELF,
    );
    assert_eq!(env.spent_today().await?, ZERO);
    Ok(())
}

/// A5: an injected agent drips 0.1 NEAR (= unknown_payee_max) 60 times.
/// Also measures the gas per `pay` and the agent key allowance consumed.
#[tokio::test]
async fn drip_drain_stops_at_daily() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let mallory = env.account("mallory").await?;
    let before = env.balance(&mallory).await?;
    let allowance_before = env.agent_allowance().await?;
    let (mut n_paid, mut n_rejected) = (0, 0);
    let mut max_burnt = NearGas::from_gas(0);
    for i in 0..60 {
        let res = env.pay(&mallory, MILLI(100)).await?.assert_success();
        max_burnt = max_burnt.max(res.total_gas_burnt);
        let outcome: Value = res.json()?;
        if i < 50 {
            assert_eq!(outcome, paid(&mallory, MILLI(100)), "call {i}");
            n_paid += 1;
        } else {
            assert_eq!(outcome, rejected("over daily cap"), "call {i}");
            n_rejected += 1;
        }
    }
    assert_eq!((n_paid, n_rejected), (50, 10));
    assert_eq!(env.spent_today().await?, NearToken::from_near(5));
    assert_eq!(
        env.balance(&mallory).await?,
        before.saturating_add(NearToken::from_near(5))
    );
    let allowance_after = env.agent_allowance().await?;
    let used = allowance_before.saturating_sub(allowance_after);
    println!(
        "GAS: max total_gas_burnt per pay = {} TGas ({} gas); allowance used by 60 pays at {} TGas \
         attached = {} yocto ({} milliNEAR); left = {}",
        max_burnt.as_tgas(),
        max_burnt.as_gas(),
        AGENT_GAS.as_tgas(),
        used.as_yoctonear(),
        used.as_millinear(),
        allowance_after
    );
    // 60 calls must fit comfortably inside the 1 NEAR allowance.
    assert!(used < MILLI(500), "allowance used: {used}");
    Ok(())
}

#[tokio::test]
async fn registry_unavailable_rejects_and_releases() -> R {
    for setup in [Registry::NoContract, Registry::Missing] {
        let env = Env::with_registry(setup).await?;
        let bob = env.account("bob").await?;
        env.trust(&bob).await?;
        let before = env.balance(&bob).await?;
        let res = env.pay(&bob, MILLI(100)).await?.assert_success();
        let ev = events(&res.logs(), "payment_rejected");
        assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
        assert_eq!(ev[0]["data"]["reason"], "registry unavailable");
        assert_eq!(res.json::<Value>()?, rejected("registry unavailable"));
        assert_eq!(env.spent_today().await?, ZERO);
        assert_eq!(env.balance(&bob).await?, before);
    }
    Ok(())
}

#[tokio::test]
async fn pay_to_missing_account_releases_reservation() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let nobody: AccountId = "nobody-xyz.sandbox".parse()?;
    let vault_before = env.balance(&env.vault).await?;
    let res = env.pay(&nobody, MILLI(100)).await?.assert_success();
    let logs = res.logs();
    let ev = events(&logs, "payment_failed");
    assert_eq!(ev.len(), 1, "logs: {logs:?}");
    assert_eq!(ev[0]["data"]["id"], Value::Null);
    assert_eq!(ev[0]["data"]["receiver"], json!(nobody));
    assert_eq!(ev[0]["data"]["reason"], "transfer failed");
    assert!(events(&logs, "payment_paid").is_empty(), "logs: {logs:?}");
    assert_eq!(res.json::<Value>()?, failed("transfer failed"));
    assert_eq!(env.spent_today().await?, ZERO);
    // The 0.1 NEAR came back; only gas (paid by the vault account) is gone.
    let lost = vault_before.saturating_sub(env.balance(&env.vault).await?);
    assert!(lost < MILLI(10), "vault lost {lost}");
    Ok(())
}

/// An approved payment whose transfer fails is dropped from the queue (not
/// re-queued): its reservation is released and `payment_failed` carries its id.
#[tokio::test]
async fn approve_transfer_failure_releases_and_drops() -> R {
    let env = Env::new().await?;
    let nobody: AccountId = "nobody-xyz.sandbox".parse()?;
    let id = pending_id(&env.request_approval(&nobody, MILLI(300)).await?);
    let res = env
        .owner_call("approve", json!({"id": id}))
        .await?
        .assert_success();
    let logs = res.logs();
    assert_eq!(events(&logs, "payment_approved").len(), 1, "logs: {logs:?}");
    assert!(events(&logs, "payment_paid").is_empty(), "logs: {logs:?}");
    let ev = events(&logs, "payment_failed");
    assert_eq!(ev.len(), 1, "logs: {logs:?}");
    assert_eq!(ev[0]["data"]["id"], json!(id));
    assert_eq!(res.json::<Value>()?, failed("transfer failed"));
    assert_eq!(env.spent_today().await?, ZERO);
    assert!(env.pending().await?.is_empty());
    Ok(())
}

/// The RPC's `InvalidTxError` for a refused transaction, e.g.
/// `{"InvalidAccessKeyError": "RequiresFullAccess"}`.
fn invalid_tx(resp: &Value) -> &Value {
    let e = &resp["error"]["data"]["TxExecutionError"]["InvalidTxError"];
    assert!(!e.is_null(), "expected an InvalidTxError, got: {resp}");
    e
}

#[tokio::test]
async fn fc_key_cannot_transfer_or_call_owner_methods() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    let id = pending_id(&env.request_approval(&bob, ONE).await?);
    let vault_before = env.balance(&env.vault).await?;
    let bob_before = env.balance(&bob).await?;

    // A plain Transfer action needs a full-access key. (Kept under the key's
    // allowance: the allowance check runs first and would mask the kind.)
    let resp = env
        .raw_send(
            near_api::Tokens::account(env.vault.clone())
                .send_to(bob.clone())
                .near(MILLI(100))
                .with_signer(env.agent.clone()),
        )
        .await?;
    assert_eq!(
        invalid_tx(&resp),
        &json!({"InvalidAccessKeyError": "RequiresFullAccess"})
    );

    // approve is not in the key's method list.
    let resp = env
        .raw_send(
            env.contract
                .call_function("approve", json!({"id": id}))
                .transaction()
                .with_signer(env.vault.clone(), env.agent.clone()),
        )
        .await?;
    assert_eq!(
        invalid_tx(&resp),
        &json!({"InvalidAccessKeyError": {"MethodNameMismatch": {"method_name": "approve"}}})
    );

    // withdraw needs 1 yocto, which a function-call key cannot attach.
    let resp = env
        .raw_send(
            env.contract
                .call_function("withdraw", json!({"amount": ONE}))
                .transaction()
                .deposit(NearToken::from_yoctonear(1))
                .with_signer(env.vault.clone(), env.agent.clone()),
        )
        .await?;
    assert_eq!(
        invalid_tx(&resp),
        &json!({"InvalidAccessKeyError": "DepositWithFunctionCall"})
    );

    assert_eq!(env.balance(&bob).await?, bob_before);
    assert_eq!(env.balance(&env.vault).await?, vault_before);
    assert_eq!(env.pending().await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn report_forwards_and_caps_at_5() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    for i in 1..=5 {
        let target = format!("bad{i}.sandbox");
        let res = env.agent_report(&target, "drainer").await?.assert_success();
        let ev = events(&res.logs(), "report_forwarded");
        assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
        assert_eq!(ev[0]["data"]["target"], json!(target));
        assert!(res.json::<bool>()?, "report {i} should land");
        let reports: Vec<Value> = env
            .registry_view(
                "get_reports",
                json!({"target": target, "from_index": 0, "limit": 10}),
            )
            .await?;
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["reporter"], json!(env.vault));
        assert_eq!(reports[0]["category"], "drainer");
    }
    // The deposits count against the daily cap (the registry's refund of the
    // unused part is not credited back: conservative).
    assert_eq!(env.spent_today().await?, MILLI(50));
    fails_with(
        env.agent_report("bad6.sandbox", "scam").await?,
        "daily report limit reached",
    );
    let summary: Value = env
        .registry_view("get_summary", json!({"target": "bad6.sandbox"}))
        .await?;
    assert_eq!(summary["reports"], 0);
    assert_eq!(env.spent_today().await?, MILLI(50));
    Ok(())
}

#[tokio::test]
async fn report_failure_releases_deposit_and_bad_category_fails_fast() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    fails_with(
        env.agent_report("bad1.sandbox", "spam").await?,
        "invalid category",
    );
    assert_eq!(env.spent_today().await?, ZERO);

    assert!(
        env.agent_report("bad1.sandbox", "phishing")
            .await?
            .assert_success()
            .json::<bool>()?
    );
    assert_eq!(env.spent_today().await?, MILLI(10));
    // The registry refuses a second report on the same target: the deposit
    // comes back and the reservation is released.
    let vault_before = env.balance(&env.vault).await?;
    let res = env
        .agent_report("bad1.sandbox", "phishing")
        .await?
        .assert_success();
    assert!(!res.json::<bool>()?);
    assert!(events(&res.logs(), "report_forwarded").is_empty());
    assert_eq!(env.spent_today().await?, MILLI(10));
    let lost = vault_before.saturating_sub(env.balance(&env.vault).await?);
    assert!(lost < MILLI(5), "vault lost {lost}");
    Ok(())
}

// ------------------------------------------------------------ fix round 1

impl Env {
    async fn pay_with_gas(
        &self,
        receiver: &AccountId,
        amount: NearToken,
        gas: NearGas,
    ) -> R<TxResult> {
        Ok(self
            .contract
            .call_function(
                "pay",
                json!({"receiver": receiver, "amount": amount, "memo": "invoice 7"}),
            )
            .transaction()
            .gas(gas)
            .with_signer(self.vault.clone(), self.agent.clone())
            .send_to(&self.net)
            .await?)
    }

    /// Vault balance not locked for storage (same formula as the contract).
    async fn vault_available(&self) -> R<NearToken> {
        let a = near_api::Account(self.vault.clone())
            .view()
            .fetch_from(&self.net)
            .await?
            .data;
        let stake = NearToken::from_yoctonear(10u128.pow(19) * u128::from(a.storage_usage));
        Ok(a.amount.saturating_sub(stake))
    }
}

/// A vault drained to just above its storage stake rejects instead of
/// panicking (which would strand the reservation until UTC rollover).
#[tokio::test]
async fn pay_insufficient_balance_rejected() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    env.trust(&bob).await?;
    // The agent signs as the vault, so the vault must still be able to
    // prepay 50 TGas above its storage stake (~0.051 NEAR in the sandbox,
    // else the tx is refused with LackBalanceForState).
    let keep = MILLI(90);
    let available = env.vault_available().await?;
    env.owner_call(
        "withdraw",
        json!({"amount": available.saturating_sub(keep)}),
    )
    .await?
    .assert_success();
    // (Plus the small gas reward the vault earns from the owner's call.)
    let left = env.vault_available().await?;
    assert!(left < MILLI(100), "available after withdraw: {left}");

    let before = env.balance(&bob).await?;
    let res = env.pay(&bob, MILLI(100)).await?.assert_success();
    let ev = events(&res.logs(), "payment_rejected");
    assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
    assert_eq!(ev[0]["data"]["reason"], "insufficient balance");
    assert_eq!(res.json::<Value>()?, rejected("insufficient balance"));
    assert_eq!(env.spent_today().await?, ZERO);
    assert_eq!(env.balance(&bob).await?, before);

    // What the vault can still afford goes through.
    assert_eq!(env.pay_json(&bob, MILLI(20)).await?, paid(&bob, MILLI(20)));
    assert_eq!(env.spent_today().await?, MILLI(20));
    Ok(())
}

#[tokio::test]
async fn report_rejected_while_paused() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    env.owner_call("pause", json!({})).await?.assert_success();
    fails_with(env.agent_report("bad1.sandbox", "scam").await?, "paused");
    assert_eq!(env.spent_today().await?, ZERO);
    let summary: Value = env
        .registry_view("get_summary", json!({"target": "bad1.sandbox"}))
        .await?;
    assert_eq!(summary["reports"], 0);
    Ok(())
}

#[tokio::test]
async fn pay_below_min_gas_fails_without_reserving() -> R {
    let env = Env::with_registry(Registry::Deployed).await?;
    let bob = env.account("bob").await?;
    env.trust(&bob).await?;
    let before = env.balance(&bob).await?;
    fails_with(
        env.pay_with_gas(&bob, MILLI(100), NearGas::from_tgas(39))
            .await?,
        "not enough gas",
    );
    assert_eq!(env.spent_today().await?, ZERO);
    assert_eq!(env.balance(&bob).await?, before);
    // Exactly the minimum (40 TGas) is enough for the whole paid path.
    let res = env
        .pay_with_gas(&bob, MILLI(100), NearGas::from_tgas(40))
        .await?;
    assert_eq!(
        res.assert_success().json::<Value>()?,
        paid(&bob, MILLI(100))
    );
    fails_with(
        env.contract
            .call_function(
                "report",
                json!({"target": "bad1.sandbox", "category": "scam", "tx_hash": null, "note": ""}),
            )
            .transaction()
            .gas(NearGas::from_tgas(34))
            .with_signer(env.vault.clone(), env.agent.clone())
            .send_to(&env.net)
            .await?,
        "not enough gas",
    );
    assert_eq!(env.spent_today().await?, MILLI(100));
    Ok(())
}
