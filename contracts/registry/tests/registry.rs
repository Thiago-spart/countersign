//! Sandbox integration tests for the Countersign registry (Task 1, issue #3).
//!
//! Each test starts its own sandbox, deploys the registry wasm (built once per
//! test binary with cargo-near) and drives it through `near-api`.

use std::sync::OnceLock;

use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::json_types::U64;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
struct Summary {
    reports: u32,
    first_seen: Option<U64>,
    last_seen: Option<U64>,
    rebutted: bool,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Report {
    reporter: AccountId,
    category: String,
    tx_hash: Option<String>,
    note: String,
    created_at: U64,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Rebuttal {
    note: String,
    #[allow(dead_code)]
    created_at: U64,
}

type R<T = ()> = testresult::TestResult<T>;
type TxResult = near_api::types::transaction::result::TransactionResult;

fn wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        let path =
            cargo_near_build::build_with_cli(Default::default()).expect("cargo near build failed");
        std::fs::read(path).expect("read wasm")
    })
}

struct Env {
    _sandbox: near_sandbox::Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    contract: near_api::Contract,
}

impl Env {
    async fn new() -> R<Self> {
        let code = wasm().to_vec();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let id: AccountId = "registry.sandbox".parse()?;
        sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(10))
            .send()
            .await?;
        near_api::Contract::deploy(id.clone())
            .use_code(code)
            .without_init_call()
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();
        Ok(Self {
            _sandbox: sandbox,
            net,
            signer,
            contract: near_api::Contract(id),
        })
    }

    async fn account(&self, name: &str) -> R<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self._sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(10))
            .send()
            .await?;
        Ok(id)
    }

    async fn call(
        &self,
        who: &AccountId,
        method: &str,
        args: near_sdk::serde_json::Value,
        deposit: NearToken,
    ) -> R<TxResult> {
        Ok(self
            .contract
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    async fn report(
        &self,
        who: &AccountId,
        target: &AccountId,
        note: &str,
        deposit: NearToken,
    ) -> R<TxResult> {
        self.call(
            who,
            "report",
            json!({"target": target, "category": "scam", "tx_hash": null, "note": note}),
            deposit,
        )
        .await
    }

    async fn view<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: near_sdk::serde_json::Value,
    ) -> R<T> {
        Ok(self
            .contract
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    async fn summary(&self, target: &AccountId) -> R<Summary> {
        self.view("get_summary", json!({"target": target})).await
    }

    async fn balance(&self, who: &AccountId) -> R<NearToken> {
        Ok(near_api::Tokens::account(who.clone())
            .near_balance()
            .fetch_from(&self.net)
            .await?
            .total)
    }
}

const MIN: NearToken = NearToken::from_millinear(10);

#[tokio::test]
async fn report_requires_min_deposit() -> R {
    let env = Env::new().await?;
    let alice = env.account("alice").await?;
    let bad = env.account("bad").await?;
    env.report(&alice, &bad, "drained me", NearToken::from_millinear(9))
        .await?
        .assert_failure();
    assert_eq!(env.summary(&bad).await?.reports, 0);
    env.report(&alice, &bad, "drained me", MIN)
        .await?
        .assert_success();
    assert_eq!(env.summary(&bad).await?.reports, 1);
    Ok(())
}

#[tokio::test]
async fn report_refunds_excess() -> R {
    let env = Env::new().await?;
    let alice = env.account("alice").await?;
    let bad = env.account("bad").await?;
    let before = env.balance(&alice).await?;
    env.report(&alice, &bad, "drained me", NearToken::from_near(1))
        .await?
        .assert_success();
    let after = env.balance(&alice).await?;
    let spent = before.saturating_sub(after);
    assert!(
        spent < NearToken::from_millinear(20),
        "reporter spent {spent}, expected < 0.02 NEAR"
    );
    Ok(())
}

#[tokio::test]
async fn one_report_per_reporter_per_target() -> R {
    let env = Env::new().await?;
    let alice = env.account("alice").await?;
    let bad = env.account("bad").await?;
    env.report(&alice, &bad, "first", MIN)
        .await?
        .assert_success();
    env.report(&alice, &bad, "second", MIN)
        .await?
        .assert_failure();
    assert_eq!(env.summary(&bad).await?.reports, 1);
    Ok(())
}

#[tokio::test]
async fn cannot_report_self() -> R {
    let env = Env::new().await?;
    let alice = env.account("alice").await?;
    env.report(&alice, &alice, "me", MIN)
        .await?
        .assert_failure();
    assert_eq!(env.summary(&alice).await?.reports, 0);
    Ok(())
}

#[tokio::test]
async fn note_too_long_rejected() -> R {
    let env = Env::new().await?;
    let alice = env.account("alice").await?;
    let bad = env.account("bad").await?;
    let long = "x".repeat(281);
    env.report(&alice, &bad, &long, MIN).await?.assert_failure();
    let ok = "x".repeat(280);
    env.report(&alice, &bad, &ok, MIN).await?.assert_success();
    Ok(())
}

#[tokio::test]
async fn summary_counts_and_timestamps() -> R {
    let env = Env::new().await?;
    let bad = env.account("bad").await?;
    for name in ["alice", "bob", "carol"] {
        let who = env.account(name).await?;
        env.report(&who, &bad, name, MIN).await?.assert_success();
    }
    let s = env.summary(&bad).await?;
    assert_eq!(s.reports, 3);
    assert!(!s.rebutted);
    let first = s.first_seen.expect("first_seen").0;
    let last = s.last_seen.expect("last_seen").0;
    assert!(first > 0 && first <= last, "first {first} last {last}");
    Ok(())
}

#[tokio::test]
async fn withdraw_refunds_and_decrements() -> R {
    let env = Env::new().await?;
    let bad = env.account("bad").await?;
    let mut reporters = vec![];
    for name in ["alice", "bob", "carol"] {
        let who = env.account(name).await?;
        env.report(&who, &bad, &"n".repeat(280), MIN)
            .await?
            .assert_success();
        reporters.push(who);
    }
    let carol = &reporters[2];
    let before = env.balance(carol).await?;
    env.call(
        carol,
        "withdraw_report",
        json!({"target": bad}),
        NearToken::from_yoctonear(0),
    )
    .await?
    .assert_success();
    let after = env.balance(carol).await?;
    assert!(
        after > before,
        "storage refund should exceed gas: before {before}, after {after}"
    );
    assert_eq!(env.summary(&bad).await?.reports, 2);
    let reports: Vec<Report> = env
        .view(
            "get_reports",
            json!({"target": bad, "from_index": 0, "limit": 10}),
        )
        .await?;
    assert_eq!(reports.len(), 2);
    assert!(reports.iter().all(|r| &r.reporter != carol));
    // A second withdraw has nothing to remove.
    env.call(
        carol,
        "withdraw_report",
        json!({"target": bad}),
        NearToken::from_yoctonear(0),
    )
    .await?
    .assert_failure();
    Ok(())
}

#[tokio::test]
async fn rebut_only_by_target() -> R {
    let env = Env::new().await?;
    let alice = env.account("alice").await?;
    let bad = env.account("bad").await?;
    env.report(&alice, &bad, "scam", MIN)
        .await?
        .assert_success();
    env.call(&bad, "rebut", json!({"note": "not a scam"}), MIN)
        .await?
        .assert_success();
    assert!(env.summary(&bad).await?.rebutted);
    // Rebutting only touches the caller's own account.
    assert!(!env.summary(&alice).await?.rebutted);
    let r: Option<Rebuttal> = env.view("get_rebuttal", json!({"target": bad})).await?;
    assert_eq!(r.expect("rebuttal").note, "not a scam");
    let none: Option<Rebuttal> = env.view("get_rebuttal", json!({"target": alice})).await?;
    assert!(none.is_none());
    // A second rebuttal replaces the first.
    env.call(&bad, "rebut", json!({"note": "updated rebuttal"}), MIN)
        .await?
        .assert_success();
    let r: Option<Rebuttal> = env.view("get_rebuttal", json!({"target": bad})).await?;
    assert_eq!(r.expect("rebuttal").note, "updated rebuttal");
    let s = env.summary(&bad).await?;
    assert!(s.rebutted);
    assert_eq!(s.reports, 1);
    Ok(())
}

#[tokio::test]
async fn get_reports_paginates() -> R {
    let env = Env::new().await?;
    let bad = env.account("bad").await?;
    let alice = env.account("alice").await?;
    let bob = env.account("bob").await?;
    env.report(&alice, &bad, "one", MIN).await?.assert_success();
    env.call(
        &bob,
        "report",
        json!({"target": bad, "category": "phishing", "tx_hash": "abc123", "note": "two"}),
        MIN,
    )
    .await?
    .assert_success();
    let page: Vec<Report> = env
        .view(
            "get_reports",
            json!({"target": bad, "from_index": 1, "limit": 1}),
        )
        .await?;
    assert_eq!(page.len(), 1);
    let r = &page[0];
    assert_eq!(r.reporter, bob);
    assert_eq!(r.category, "phishing");
    assert_eq!(r.tx_hash.as_deref(), Some("abc123"));
    assert_eq!(r.note, "two");
    assert!(r.created_at.0 > 0);
    let empty: Vec<Report> = env
        .view(
            "get_reports",
            json!({"target": bad, "from_index": 5, "limit": 10}),
        )
        .await?;
    assert!(empty.is_empty());
    Ok(())
}

#[test]
fn no_admin_methods() -> R {
    let mut exports = vec![];
    for payload in wasmparser::Parser::new(0).parse_all(wasm()) {
        if let wasmparser::Payload::ExportSection(reader) = payload? {
            for export in reader {
                let export = export?;
                if matches!(export.kind, wasmparser::ExternalKind::Func) {
                    exports.push(export.name.to_string());
                }
            }
        }
    }
    for expected in [
        "report",
        "withdraw_report",
        "rebut",
        "get_summary",
        "get_reports",
        "get_rebuttal",
    ] {
        assert!(
            exports.iter().any(|e| e == expected),
            "missing method {expected}; exports: {exports:?}"
        );
    }
    let forbidden: Vec<&String> = exports
        .iter()
        .filter(|e| {
            e.contains("owner")
                || e.starts_with("set_")
                || e.starts_with("delete_")
                || e.contains("migrate")
        })
        .collect();
    assert!(forbidden.is_empty(), "admin-like exports: {forbidden:?}");
    Ok(())
}
