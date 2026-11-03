// Sandbox smoke test: start a local NEAR sandbox, create alice.<root> with 10 NEAR, print balance.
// First run downloads the sandbox binary into node_modules; if /tmp is on another filesystem this fails
// with EXDEV. Work around once with: TMPDIR=$PWD/.cache/tmp pnpm tsx scripts/smoke-sandbox.ts
//
// Root account (near-sandbox 0.3.x exports DEFAULT_ACCOUNT_ID / DEFAULT_PRIVATE_KEY in its
// config; also shown in node_modules/near-sandbox/dist/esm/index.d.mts):
//   id:  "sandbox"
//   key: ed25519:3tgdk2wP... (public key ed25519:5BGSaf6Y...). Well-known test key, sandbox only.
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { NEAR } from "near-api-js/tokens";
import { Sandbox } from "near-sandbox";

const ROOT_ID = "sandbox";
const ROOT_KEY =
  "ed25519:REDACTED_TEST_KEY";

const sandbox = await Sandbox.start({});
try {
  const provider = new JsonRpcProvider({ url: sandbox.rpcUrl });
  const root = new Account(ROOT_ID, provider, ROOT_KEY as KeyPairString);

  const aliceId = `alice.${ROOT_ID}`;
  const aliceKey = KeyPair.fromRandom("ed25519");
  await root.createAccount({
    newAccountId: aliceId,
    publicKey: aliceKey.getPublicKey(),
    nearToTransfer: NEAR.toUnits("10"),
  });

  // viewAccount().amount is the total balance (getBalance() would subtract locked storage).
  const { amount } = await provider.viewAccount({ accountId: aliceId });
  console.log(`${aliceId} ${NEAR.toDecimal(amount)} NEAR`);
} finally {
  await sandbox.tearDown();
}
