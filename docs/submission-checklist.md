# Submission checklist and demo draft

Source: [official HACKATHON.md](https://nearhackathon.com/HACKATHON.md), checked 2026-11-03. No substantive rule changes were found against the saved local copy. Recheck the live rules before submitting.

The project fits `security`, with `agents` and `open` as additional tracks for the human to confirm. A local-only demo is eligible; it requires a public repository, reproducible README and a public X post with a video. Testnet deployment is optional under the event rules, although it remains part of this project's implementation plan.

## Before posting

- Run the commands in the README against the final code and retain their output. The seven scripted attacks verify the SDK, contracts and protocol; they do not verify an LLM's behavior.
- Record the actual Claude/MCP interaction below. The owner key and setup recovery files must be outside the agent's accessible environment. Give the model only the Countersign MCP tools, with no file, shell or general-wallet tools that could reach owner credentials.
- Check the recording for keys, owner environment-file contents and personal information before publishing.
- Keep the repository public through judging. A testnet deployment is recorded in `deployments/testnet.json` (live attack run 5/7, see README "Live on testnet"); the 7/7 demo is the local NEAR sandbox run.

## X post draft

Attach the recorded video to this post. The human reviews and publishes it.

> An injected invoice can send an AI agent's money to a scammer.
>
> Built at NEAR HACKATHON: Countersign checks payees; NEAR scoped keys and vault caps enforce the limits.
>
> What attack should we test next?
> https://github.com/Thiago-spart/countersign
> @NEARProtocol #NEARHackathon

## Video script (60–90 seconds)

Prepare the local sandbox and separate owner shell before recording. Use the README's MCP example. These are recording instructions, not evidence that an LLM demo has already been performed.

| Time | Show | Say |
|---|---|---|
| 0–10 s | An invoice naming `acme-c0rp.sandbox`, similar to trusted `acme-corp.sandbox`. | “An injected invoice changes the payee. A spending limit alone would still allow the payment.” |
| 10–25 s | Ask Claude over Countersign MCP to pay 0.5 NEAR to `acme-c0rp.sandbox`; show the actual `REFUSED` result and reasons. | “Countersign scores the receiver before signing. This look-alike is refused.” |
| 25–40 s | Run `pnpm attacks --only A4`; show `Pending(registry_flagged)` and the unchanged receiver balance. | “Skipping the SDK still hits the vault's on-chain registry check.” |
| 40–55 s | Ask Claude to pay 0.05 NEAR to `fresh-invoice.sandbox`; show `PENDING`. From the separate owner shell, inspect `status`, then approve or deny that pending ID. | “A risky payment waits for the human owner's separate key.” |
| 55–75 s | Show a completed `pnpm attacks` run with 7/7 PASS, including A6's protocol errors. | “NEAR's function-call key cannot transfer directly or approve payments. The vault enforces the caps.” |
| 75–90 s | Show the public repo and quick-start instructions. | “Try the sandbox without funds or API keys. What attack should we add?” |

## Before submitting

- Confirm whether this repository has already been submitted. Each project gets one submission and it cannot be edited.
- Collect the human's project name, lead name, contact email, team size, tracks, existing mainnet payout account, repository URL, public demo-post URL and final project description. Do not invent missing values.
- Read the contact notice verbatim and collect consent: “I agree that the organizers may use these details to review our submission and contact us about this hackathon.”
- Generate the request ID once, validate the exact payload, display it to the human and wait for explicit confirmation before sending. Keep personal data and the payload out of git.
- Submit by **2026-11-14 23:59 UTC** (**20:59 in São Paulo**). Target **2026-11-13** to leave time for corrections before the one submission.

No public post, testnet transaction or submission is authorized by this checklist alone.
