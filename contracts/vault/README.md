# Countersign vault

One vault per AI agent (spec §5.1). The agent reaches it only through a
function-call key on the vault account (`pay`, `request_approval`, `report`);
the human owner approves or denies queued payments, pauses the vault, sets
limits and withdraws.

```sh
pnpm build:contracts                       # → contracts/res/vault.wasm
bash scripts/test-contracts.sh -p vault    # unit + sandbox integration tests
```
