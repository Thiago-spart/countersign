#!/usr/bin/env bash
# Creates the testnet scenario accounts for `pnpm attacks --network testnet` (Task 12, Step 4).
# Usage: bash scripts/testnet-scenarios.sh <root>   e.g. countersign-demo.testnet
# Signs with near-cli-rs's legacy keychain (~/.near-credentials/testnet). Asks before sending anything.
# near-cli output is not filtered: it can stop to ask (e.g. retry after an RPC error), and a pipe would hide that.
set -euo pipefail

root="${1:?usage: $0 <root account, e.g. countersign-demo.testnet>}"
registry="registry.${root}"
vault="vault.${root}"
net=(network-config testnet)

payees=(acme-corp acme-c0rp fresh-invoice reported unknown-payee)
reporters=(reporter1 reporter2 reporter3)

echo "From ${root} on testnet, this sends:"
echo "  - ${#payees[@]} payee accounts (${payees[*]}) under ${root}, 0.1 NEAR each"
echo "  - ${#reporters[@]} reporter accounts under ${root}, 0.1 NEAR each"
echo "  - 3 reports of reported.${root} to ${registry} (0.02 NEAR deposit each)"
echo "  - ${vault}.trust(acme-corp.${root}), signed by the owner (1 yoctoNEAR)"
read -r -p "Send these transactions? [y/N] " ok
[[ "$ok" == "y" || "$ok" == "yes" ]] || { echo "Nothing sent."; exit 1; }

exists() {
  near account view-account-summary "$1" "${net[@]}" now >/dev/null 2>&1
}

create() {
  local id="$1.${root}"
  if exists "$id"; then echo "exists: $id"; return; fi
  near account create-account fund-myself "$id" '0.1 NEAR' autogenerate-new-keypair --signature-scheme ed25519 save-to-legacy-keychain \
    sign-as "$root" "${net[@]}" sign-with-legacy-keychain send
}

for a in "${payees[@]}" "${reporters[@]}"; do create "$a"; done

for r in "${reporters[@]}"; do
  near contract call-function as-transaction "$registry" report \
    json-args "{\"target\":\"reported.${root}\",\"category\":\"scam\",\"tx_hash\":null,\"note\":\"took payment, delivered nothing\"}" \
    prepaid-gas '30 Tgas' attached-deposit '0.02 NEAR' \
    sign-as "${r}.${root}" "${net[@]}" sign-with-legacy-keychain send
done

near contract call-function as-transaction "$vault" trust \
  json-args "{\"account_id\":\"acme-corp.${root}\"}" \
  prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as "$root" "${net[@]}" sign-with-legacy-keychain send

echo "Done. Add COUNTERSIGN_ATTACK_ROOT=${root} to .env, then: pnpm attacks --network testnet"
