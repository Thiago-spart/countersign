// Sandbox smoke test: start a local NEAR sandbox, create alice.<root> with 10 NEAR, print balance.
// Root account is near-sandbox's DEFAULT_ACCOUNT_ID ("sandbox") with its DEFAULT_PRIVATE_KEY.
import "./sandbox-env.js";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { NEAR } from "near-api-js/tokens";
import { DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY, Sandbox } from "near-sandbox";

const ROOT_ID = DEFAULT_ACCOUNT_ID;
const ROOT_KEY = DEFAULT_PRIVATE_KEY;

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
