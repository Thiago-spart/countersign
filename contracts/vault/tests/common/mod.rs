//! Shared sandbox helpers for the vault integration tests.
//!
//! Agent calls are signed with a function-call access key on the vault
//! account (receiver = vault, methods = pay/request_approval/report,
//! allowance 1 NEAR), the same way production agents call it.
#![allow(dead_code)]

use std::sync::{Arc, OnceLock};

use near_api::types::{AccessKeyPermission, transaction::actions::FunctionCallPermission};
use near_api::{AccountId, NearGas, NearToken, NetworkConfig, Signer};
use near_sdk::json_types::U64;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{Value, json};

pub type R<T = ()> = testresult::TestResult<T>;
pub type TxResult = near_api::types::transaction::result::TransactionResult;

#[derive(Deserialize, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct Limits {
    pub per_tx: NearToken,
    pub daily: NearToken,
    pub unknown_payee_max: NearToken,
    pub registry_pending_threshold: u32,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct PendingPayment {
    pub id: U64,
    pub receiver: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub reason: String,
    pub created_at: U64,
}

/// The vault wasm, built fresh from this crate once per test binary.
pub fn wasm() -> &'static [u8] {
    static WASM: OnceLock<Vec<u8>> = OnceLock::new();
    WASM.get_or_init(|| {
        let path =
            cargo_near_build::build_with_cli(Default::default()).expect("cargo near build failed");
        std::fs::read(path).expect("read wasm")
    })
}

/// The prebuilt registry wasm (`pnpm build:contracts`).
pub fn registry_wasm() -> Vec<u8> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../res/registry.wasm");
    std::fs::read(path).expect("contracts/res/registry.wasm missing: run `pnpm build:contracts`")
}

pub const AGENT_METHODS: [&str; 3] = ["pay", "request_approval", "report"];
/// Owner methods that loosen controls or move funds require exactly 1 yoctoNEAR.
pub const ONE_YOCTO_METHODS: [&str; 6] = [
    "approve",
    "unpause",
    "set_limits",
    "trust",
    "untrust",
    "withdraw",
];
pub const NOT_OWNER: &str = "only the owner can call this";
pub const NOT_SELF: &str = "only the vault itself can call this";
pub const ONE_YOCTO_MSG: &str = "Requires attached deposit of exactly 1 yoctoNEAR";
pub const ONE: NearToken = NearToken::from_near(1);
/// Gas the agent attaches to `pay` / `report` (what the SDK should use).
pub const AGENT_GAS: NearGas = NearGas::from_tgas(50);

/// Where the vault's `registry_id` points.
pub enum Registry {
    /// `registry.sandbox`, not created (tests that never reach the registry).
    Missing,
    /// `registry.sandbox` with the registry contract deployed.
    Deployed,
    /// `registry.sandbox` exists but has no contract.
    NoContract,
}

pub struct Env {
    pub sandbox: near_sandbox::Sandbox,
    pub net: NetworkConfig,
    /// Full-access genesis key; every sandbox account created here has it.
    pub signer: Arc<Signer>,
    /// Function-call key on the vault account (the agent's key).
    pub agent: Arc<Signer>,
    pub vault: AccountId,
    pub owner: AccountId,
    pub registry: AccountId,
    pub contract: near_api::Contract,
}

impl Env {
    pub async fn new() -> R<Self> {
        Self::with_registry(Registry::Missing).await
    }

    pub async fn with_registry(registry_setup: Registry) -> R<Self> {
        let code = wasm().to_vec();
        let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
        let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(
            near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
        )?;
        let vault: AccountId = "vault.sandbox".parse()?;
        let owner: AccountId = "owner.sandbox".parse()?;
        let registry: AccountId = "registry.sandbox".parse()?;
        for (id, bal) in [(&vault, 30), (&owner, 10)] {
            sandbox
                .create_account(id.clone())
                .initial_balance(NearToken::from_near(bal))
                .send()
                .await?;
        }
        match registry_setup {
            Registry::Missing => {}
            Registry::Deployed | Registry::NoContract => {
                sandbox
                    .create_account(registry.clone())
                    .initial_balance(NearToken::from_near(10))
                    .send()
                    .await?;
            }
        }
        if let Registry::Deployed = registry_setup {
            near_api::Contract::deploy(registry.clone())
                .use_code(registry_wasm())
                .without_init_call()
                .with_signer(signer.clone())
                .send_to(&net)
                .await?
                .assert_success();
        }
        near_api::Contract::deploy(vault.clone())
            .use_code(code)
            .with_init_call(
                "new",
                json!({"owner_id": owner, "registry_id": registry, "limits": null}),
            )?
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();

        // The agent's function-call key on the vault account (ruling R3: 1 NEAR allowance).
        let agent_sk = near_api::signer::generate_secret_key()?;
        let agent = Signer::from_secret_key(agent_sk)?;
        near_api::Account(vault.clone())
            .add_key(
                AccessKeyPermission::FunctionCall(FunctionCallPermission {
                    allowance: Some(NearToken::from_near(1)),
                    receiver_id: vault.to_string(),
                    method_names: AGENT_METHODS.iter().map(|m| m.to_string()).collect(),
                }),
                agent.get_public_key().await?,
            )
            .with_signer(signer.clone())
            .send_to(&net)
            .await?
            .assert_success();

        Ok(Self {
            sandbox,
            net,
            signer,
            agent,
            contract: near_api::Contract(vault.clone()),
            vault,
            owner,
            registry,
        })
    }

    pub async fn account(&self, name: &str) -> R<AccountId> {
        let id: AccountId = format!("{name}.sandbox").parse()?;
        self.sandbox
            .create_account(id.clone())
            .initial_balance(NearToken::from_near(10))
            .send()
            .await?;
        Ok(id)
    }

    /// Call with the deposit the method expects (1 yocto for `ONE_YOCTO_METHODS`).
    pub async fn call(&self, who: &AccountId, method: &str, args: Value) -> R<TxResult> {
        let deposit = if ONE_YOCTO_METHODS.contains(&method) {
            NearToken::from_yoctonear(1)
        } else {
            NearToken::from_yoctonear(0)
        };
        self.call_with(who, method, args, deposit).await
    }

    pub async fn call_with(
        &self,
        who: &AccountId,
        method: &str,
        args: Value,
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

    pub async fn owner_call(&self, method: &str, args: Value) -> R<TxResult> {
        self.call(&self.owner.clone(), method, args).await
    }

    /// Call as the agent: the vault account, signed with the function-call key.
    pub async fn agent_call(&self, method: &str, args: Value) -> R<TxResult> {
        Ok(self
            .contract
            .call_function(method, args)
            .transaction()
            .gas(AGENT_GAS)
            .with_signer(self.vault.clone(), self.agent.clone())
            .send_to(&self.net)
            .await?)
    }

    pub async fn request_approval(&self, receiver: &AccountId, amount: NearToken) -> R<Value> {
        Ok(self
            .agent_call(
                "request_approval",
                json!({"receiver": receiver, "amount": amount, "memo": "invoice 42",
                       "reason": "agent asked"}),
            )
            .await?
            .assert_success()
            .json()?)
    }

    pub async fn view<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> R<T> {
        Ok(self
            .contract
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    pub async fn registry_view<T: near_sdk::serde::de::DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> R<T> {
        Ok(near_api::Contract(self.registry.clone())
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.net)
            .await?
            .data)
    }

    /// Call the registry as `who` (a full-access sandbox account).
    pub async fn registry_call(
        &self,
        who: &AccountId,
        method: &str,
        args: Value,
        deposit: NearToken,
    ) -> R<TxResult> {
        Ok(near_api::Contract(self.registry.clone())
            .call_function(method, args)
            .transaction()
            .deposit(deposit)
            .with_signer(who.clone(), self.signer.clone())
            .send_to(&self.net)
            .await?)
    }

    /// Sign `tx` and broadcast it over raw JSON-RPC, returning the whole
    /// response. near-api turns `InvalidTransaction` errors into an empty
    /// map, so tests that assert the protocol error kind use this instead.
    pub async fn raw_send(&self, tx: near_api::advanced::ExecuteSignedTransaction) -> R<Value> {
        use base64::Engine;
        let signed = tx
            .presign_with(&self.net)
            .await?
            .transaction
            .signed()
            .expect("presigned");
        let b64 =
            base64::engine::general_purpose::STANDARD.encode(near_sdk::borsh::to_vec(&signed)?);
        let body = json!({"jsonrpc": "2.0", "id": "t", "method": "broadcast_tx_commit",
                          "params": [b64]});
        Ok(reqwest::Client::new()
            .post(&self.sandbox.rpc_addr)
            .json(&body)
            .send()
            .await?
            .json()
            .await?)
    }

    pub async fn pending(&self) -> R<Vec<PendingPayment>> {
        self.view("get_pending", json!({})).await
    }

    pub async fn spent_today(&self) -> R<NearToken> {
        self.view("get_spent_today", json!({})).await
    }

    pub async fn balance(&self, who: &AccountId) -> R<NearToken> {
        Ok(near_api::Tokens::account(who.clone())
            .near_balance()
            .fetch_from(&self.net)
            .await?
            .total)
    }

    /// Queue `amount` for `receiver` and approve it; returns the approve result.
    pub async fn request_and_approve(&self, receiver: &AccountId, amount: NearToken) -> R<Value> {
        let id = pending_id(&self.request_approval(receiver, amount).await?);
        Ok(self
            .owner_call("approve", json!({"id": id}))
            .await?
            .assert_success()
            .json()?)
    }
}

pub fn pending_id(outcome: &Value) -> U64 {
    assert_eq!(outcome["status"], "pending", "expected pending: {outcome}");
    U64(outcome["id"].as_str().expect("id").parse().expect("u64"))
}

/// Assert the transaction failed and its error mentions `msg`.
pub fn fails_with(res: TxResult, msg: &str) {
    let err = format!("{:?}", res.assert_failure());
    assert!(
        err.contains(msg),
        "expected failure containing {msg:?}, got: {err}"
    );
}

pub fn rejected(reason: &str) -> Value {
    json!({"status": "rejected", "reason": reason})
}

/// NEP-297 events with the given name in the logs.
pub fn events(logs: &[&str], name: &str) -> Vec<Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str::<Value>(j).expect("event json"))
        .filter(|e| e["standard"] == "countersign" && e["version"] == "1.0.0" && e["event"] == name)
        .collect()
}
