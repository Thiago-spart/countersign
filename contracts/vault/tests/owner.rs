//! Sandbox integration tests for the vault's owner controls and approval
//! queue (Task 2, issue #4).
//!
//! Agent calls are signed with a function-call access key on the vault
//! account (receiver = vault, methods = pay/request_approval/report,
//! allowance 1 NEAR), the same way production agents call it.

mod common;

use common::*;
use near_api::NearToken;
use near_sdk::json_types::U64;
use near_sdk::serde_json::{Value, json};

#[tokio::test]
async fn init_sets_defaults() -> R {
    let env = Env::new().await?;
    let limits: Limits = env.view("get_limits", json!({})).await?;
    assert_eq!(
        limits,
        Limits {
            per_tx: ONE,
            daily: NearToken::from_near(5),
            unknown_payee_max: NearToken::from_millinear(100),
            registry_pending_threshold: 2,
        }
    );
    assert!(!env.view::<bool>("is_paused", json!({})).await?);
    assert_eq!(env.spent_today().await?, NearToken::from_yoctonear(0));
    assert!(env.pending().await?.is_empty());
    // A second init is refused.
    let res = env
        .call(
            &env.vault.clone(),
            "new",
            json!({"owner_id": env.owner, "registry_id": "registry.sandbox", "limits": null}),
        )
        .await?;
    fails_with(res, "The contract has already been initialized");
    Ok(())
}

#[tokio::test]
async fn owner_methods_reject_non_owner() -> R {
    let env = Env::new().await?;
    let stranger = env.account("stranger").await?;
    let bob = env.account("bob").await?;
    let id = pending_id(&env.request_approval(&bob, ONE).await?);
    let limits = json!({"per_tx": "1", "daily": "1", "unknown_payee_max": "1",
                        "registry_pending_threshold": 1});
    for (method, args) in [
        ("pause", json!({})),
        ("unpause", json!({})),
        ("set_limits", json!({ "limits": limits })),
        ("trust", json!({"account_id": stranger})),
        ("untrust", json!({"account_id": bob})),
        ("withdraw", json!({"amount": ONE})),
        ("approve", json!({"id": id})),
        ("deny", json!({"id": id})),
    ] {
        fails_with(env.call(&stranger, method, args).await?, NOT_OWNER);
    }
    // Nothing changed.
    assert!(!env.view::<bool>("is_paused", json!({})).await?);
    assert!(
        !env.view::<bool>("is_trusted", json!({"account_id": stranger}))
            .await?
    );
    assert_eq!(
        env.view::<Limits>("get_limits", json!({})).await?.per_tx,
        ONE
    );
    assert_eq!(env.pending().await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn owner_config_methods_work() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    env.owner_call("trust", json!({"account_id": bob}))
        .await?
        .assert_success();
    assert!(
        env.view::<bool>("is_trusted", json!({"account_id": bob}))
            .await?
    );
    env.owner_call("untrust", json!({"account_id": bob}))
        .await?
        .assert_success();
    assert!(
        !env.view::<bool>("is_trusted", json!({"account_id": bob}))
            .await?
    );
    let new_limits = json!({"per_tx": NearToken::from_near(2), "daily": NearToken::from_near(10),
                            "unknown_payee_max": NearToken::from_millinear(500),
                            "registry_pending_threshold": 3});
    env.owner_call("set_limits", json!({ "limits": new_limits }))
        .await?
        .assert_success();
    assert_eq!(
        env.view::<Limits>("get_limits", json!({})).await?,
        Limits {
            per_tx: NearToken::from_near(2),
            daily: NearToken::from_near(10),
            unknown_payee_max: NearToken::from_millinear(500),
            registry_pending_threshold: 3,
        }
    );
    Ok(())
}

#[tokio::test]
async fn request_approval_requires_self_predecessor() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    // Another account (even the owner) cannot queue payments.
    let args = json!({"receiver": bob, "amount": ONE, "memo": "m", "reason": "r"});
    fails_with(
        env.call(&bob, "request_approval", args.clone()).await?,
        NOT_SELF,
    );
    fails_with(env.owner_call("request_approval", args).await?, NOT_SELF);
    assert!(env.pending().await?.is_empty());

    // The vault itself, through the agent's function-call key.
    let res = env
        .agent_call(
            "request_approval",
            json!({"receiver": bob, "amount": ONE, "memo": "invoice 42", "reason": "agent asked"}),
        )
        .await?
        .assert_success();
    let ev = events(&res.logs(), "payment_pending");
    assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
    let outcome: Value = res.json()?;
    let id = pending_id(&outcome);
    assert_eq!(outcome["reason"], "agent asked");
    assert_eq!(ev[0]["data"]["id"], json!(id));
    assert_eq!(ev[0]["data"]["receiver"], json!(bob));

    let pending = env.pending().await?;
    assert_eq!(pending.len(), 1);
    let p = &pending[0];
    assert_eq!((p.id, &p.receiver, p.amount), (id, &bob, ONE));
    assert_eq!(
        (p.memo.as_str(), p.reason.as_str()),
        ("invoice 42", "agent asked")
    );
    assert!(p.created_at.0 > 0);
    Ok(())
}

#[tokio::test]
async fn request_approval_respects_per_tx_and_pause() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let res = env
        .agent_call(
            "request_approval",
            json!({"receiver": bob, "amount": NearToken::from_millinear(1500),
                   "memo": "m", "reason": "r"}),
        )
        .await?
        .assert_success();
    assert_eq!(events(&res.logs(), "payment_rejected").len(), 1);
    assert_eq!(res.json::<Value>()?, rejected("over per-tx cap"));

    let res = env.owner_call("pause", json!({})).await?.assert_success();
    assert_eq!(events(&res.logs(), "paused").len(), 1);
    assert!(env.view::<bool>("is_paused", json!({})).await?);
    assert_eq!(
        env.request_approval(&bob, NearToken::from_millinear(100))
            .await?,
        rejected("paused")
    );
    assert!(env.pending().await?.is_empty());

    let res = env.owner_call("unpause", json!({})).await?.assert_success();
    assert_eq!(events(&res.logs(), "unpaused").len(), 1);
    pending_id(
        &env.request_approval(&bob, NearToken::from_millinear(100))
            .await?,
    );
    Ok(())
}

#[tokio::test]
async fn pending_queue_caps_at_50() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    for _ in 0..50 {
        pending_id(
            &env.request_approval(&bob, NearToken::from_millinear(10))
                .await?,
        );
    }
    assert_eq!(env.pending().await?.len(), 50);
    assert_eq!(
        env.request_approval(&bob, NearToken::from_millinear(10))
            .await?,
        rejected("pending queue full")
    );
    assert_eq!(env.pending().await?.len(), 50);
    // Denying one frees a slot.
    env.owner_call("deny", json!({"id": U64(0)}))
        .await?
        .assert_success();
    pending_id(
        &env.request_approval(&bob, NearToken::from_millinear(10))
            .await?,
    );
    Ok(())
}

#[tokio::test]
async fn approve_pays_and_counts_daily() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let id = pending_id(&env.request_approval(&bob, ONE).await?);
    let before = env.balance(&bob).await?;
    let res = env
        .owner_call("approve", json!({"id": id}))
        .await?
        .assert_success();
    let logs = res.logs();
    let approved = events(&logs, "payment_approved");
    let paid = events(&logs, "payment_paid");
    assert_eq!((approved.len(), paid.len()), (1, 1), "logs: {logs:?}");
    assert_eq!(approved[0]["data"]["id"], json!(id));
    assert_eq!(paid[0]["data"]["receiver"], json!(bob));
    assert_eq!(paid[0]["data"]["amount"], json!(ONE));
    assert_eq!(
        res.json::<Value>()?,
        json!({"status": "paid", "receiver": bob, "amount": ONE})
    );
    assert_eq!(env.balance(&bob).await?, before.saturating_add(ONE));
    assert_eq!(env.spent_today().await?, ONE);
    assert!(env.pending().await?.is_empty());
    // An approved id cannot be approved again.
    fails_with(
        env.owner_call("approve", json!({"id": id})).await?,
        "no such pending payment",
    );
    Ok(())
}

#[tokio::test]
async fn approve_rechecks_daily_cap() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    for amount in [ONE, ONE, ONE, ONE, NearToken::from_millinear(500)] {
        assert_eq!(
            env.request_and_approve(&bob, amount).await?["status"],
            "paid"
        );
    }
    assert_eq!(env.spent_today().await?, NearToken::from_millinear(4500));

    let id = pending_id(&env.request_approval(&bob, ONE).await?);
    let before = env.balance(&bob).await?;
    let res = env
        .owner_call("approve", json!({"id": id}))
        .await?
        .assert_success();
    let ev = events(&res.logs(), "payment_rejected");
    assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
    assert_eq!(ev[0]["data"]["id"], json!(id));
    assert_eq!(ev[0]["data"]["reason"], "over daily cap");
    assert_eq!(res.json::<Value>()?, rejected("over daily cap"));
    assert_eq!(env.balance(&bob).await?, before);
    assert_eq!(env.spent_today().await?, NearToken::from_millinear(4500));
    let pending = env.pending().await?;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, id);
    Ok(())
}

#[tokio::test]
async fn approve_when_paused_rejected() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let id = pending_id(&env.request_approval(&bob, ONE).await?);
    env.owner_call("pause", json!({})).await?.assert_success();
    let before = env.balance(&bob).await?;
    let res = env
        .owner_call("approve", json!({"id": id}))
        .await?
        .assert_success();
    assert_eq!(res.json::<Value>()?, rejected("paused"));
    assert_eq!(env.balance(&bob).await?, before);
    assert_eq!(env.spent_today().await?, NearToken::from_yoctonear(0));
    assert_eq!(env.pending().await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn deny_removes() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let keep = pending_id(&env.request_approval(&bob, ONE).await?);
    let id = pending_id(
        &env.request_approval(&bob, NearToken::from_millinear(200))
            .await?,
    );
    let before = env.balance(&bob).await?;
    let res = env
        .owner_call("deny", json!({"id": id}))
        .await?
        .assert_success();
    let ev = events(&res.logs(), "payment_denied");
    assert_eq!(ev.len(), 1, "logs: {:?}", res.logs());
    assert_eq!(ev[0]["data"]["id"], json!(id));
    let pending = env.pending().await?;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, keep);
    assert_eq!(env.balance(&bob).await?, before);
    // Unknown id.
    fails_with(
        env.owner_call("deny", json!({"id": id})).await?,
        "no such pending payment",
    );
    Ok(())
}

#[tokio::test]
async fn withdraw_sends_to_owner() -> R {
    let env = Env::new().await?;
    let owner_before = env.balance(&env.owner).await?;
    let vault_before = env.balance(&env.vault).await?;
    env.owner_call("withdraw", json!({"amount": NearToken::from_near(5)}))
        .await?
        .assert_success();
    let owner_after = env.balance(&env.owner).await?;
    let gained = owner_after.saturating_sub(owner_before);
    // 5 NEAR minus the owner's gas.
    assert!(
        gained > NearToken::from_millinear(4990) && gained <= NearToken::from_near(5),
        "owner gained {gained}"
    );
    let vault_after = env.balance(&env.vault).await?;
    // The vault also earns a small gas reward from the owner's call.
    let lost = vault_before.saturating_sub(vault_after);
    assert!(
        lost > NearToken::from_millinear(4990) && lost <= NearToken::from_near(5),
        "vault lost {lost}"
    );
    // More than the vault holds is refused.
    fails_with(
        env.owner_call("withdraw", json!({"amount": NearToken::from_near(1000)}))
            .await?,
        "insufficient available balance",
    );
    Ok(())
}

#[tokio::test]
async fn withdraw_keeps_storage_stake() -> R {
    let env = Env::new().await?;
    // The whole account balance includes the stake locked for contract
    // storage, so withdrawing all of it is refused.
    let all = env.balance(&env.vault).await?;
    fails_with(
        env.owner_call("withdraw", json!({ "amount": all })).await?,
        "insufficient available balance",
    );
    Ok(())
}

#[tokio::test]
async fn sensitive_owner_methods_require_one_yocto() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let id = pending_id(&env.request_approval(&bob, ONE).await?);
    let zero = NearToken::from_yoctonear(0);
    let owner = env.owner.clone();
    fails_with(
        env.call_with(&owner, "approve", json!({"id": id}), zero)
            .await?,
        ONE_YOCTO_MSG,
    );
    fails_with(
        env.call_with(&owner, "withdraw", json!({"amount": ONE}), zero)
            .await?,
        ONE_YOCTO_MSG,
    );
    assert_eq!(env.pending().await?.len(), 1);
    // pause and deny stay deposit-free.
    env.call_with(&owner, "pause", json!({}), zero)
        .await?
        .assert_success();
    env.call_with(&owner, "deny", json!({"id": id}), zero)
        .await?
        .assert_success();
    Ok(())
}

#[tokio::test]
async fn memo_and_reason_capped_at_280_bytes() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let ok = "x".repeat(280);
    let long = "x".repeat(281);
    let amount = NearToken::from_millinear(10);
    for (memo, reason, msg) in [
        (&long, &ok, "memo exceeds 280 bytes"),
        (&ok, &long, "reason exceeds 280 bytes"),
    ] {
        fails_with(
            env.agent_call(
                "request_approval",
                json!({"receiver": bob, "amount": amount, "memo": memo, "reason": reason}),
            )
            .await?,
            msg,
        );
    }
    assert!(env.pending().await?.is_empty());
    let res = env
        .agent_call(
            "request_approval",
            json!({"receiver": bob, "amount": amount, "memo": ok, "reason": ok}),
        )
        .await?
        .assert_success();
    pending_id(&res.json()?);
    let pending = env.pending().await?;
    assert_eq!((pending[0].memo.len(), pending[0].reason.len()), (280, 280));
    Ok(())
}

#[tokio::test]
async fn get_trusted_lists_trusted_accounts() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let carol = env.account("carol").await?;
    assert!(env.view::<Vec<String>>("get_trusted", json!({})).await?.is_empty());
    for a in [&bob, &carol] {
        env.owner_call("trust", json!({"account_id": a}))
            .await?
            .assert_success();
    }
    let mut trusted: Vec<String> = env.view("get_trusted", json!({})).await?;
    trusted.sort();
    let mut want = vec![bob.to_string(), carol.to_string()];
    want.sort();
    assert_eq!(trusted, want);
    env.owner_call("untrust", json!({"account_id": bob}))
        .await?
        .assert_success();
    let trusted: Vec<String> = env.view("get_trusted", json!({})).await?;
    assert_eq!(trusted, vec![carol.to_string()]);
    Ok(())
}

/// An approved payment the vault can no longer afford fails the whole
/// `approve` receipt: nothing is sent, the payment stays pending and the
/// daily reservation is rolled back (audit note I-5 in SECURITY.md).
#[tokio::test]
async fn approve_unaffordable_payment_rolls_back() -> R {
    let env = Env::new().await?;
    let bob = env.account("bob").await?;
    let id = pending_id(&env.request_approval(&bob, ONE).await?);
    // Leave ~0.5 NEAR above the storage stake.
    let a = near_api::Account(env.vault.clone())
        .view()
        .fetch_from(&env.net)
        .await?
        .data;
    let stake = NearToken::from_yoctonear(10u128.pow(19) * u128::from(a.storage_usage));
    let available = a.amount.saturating_sub(stake);
    env.owner_call(
        "withdraw",
        json!({"amount": available.saturating_sub(NearToken::from_millinear(500))}),
    )
    .await?
    .assert_success();
    let bob_before = env.balance(&bob).await?;

    // The transfer receipt would take the vault below its storage stake, so
    // the runtime fails the whole `approve` receipt.
    fails_with(
        env.owner_call("approve", json!({ "id": id })).await?,
        "LackBalanceForState",
    );

    assert_eq!(env.pending().await?.len(), 1, "payment must stay pending");
    assert_eq!(env.spent_today().await?, NearToken::from_yoctonear(0));
    assert_eq!(env.balance(&bob).await?, bob_before);
    Ok(())
}
