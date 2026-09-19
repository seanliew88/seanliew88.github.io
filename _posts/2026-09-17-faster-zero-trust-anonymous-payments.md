---
title: Faster Zero-Trust Anonymous Payments
date: 2026-09-17 00:00:00 +0800
description: Designing a privacy-preserving settlement layer that breaks the direct on-chain link between stablecoin buyers and merchants.
permalink: /projects/fzap/
toc: true
comments: false
---

[View the source on GitHub](https://github.com/seanliew88/Faster-Zero-Trust-Anonymous-Payments-FZAP-){: .btn .btn-outline-primary }

Public blockchains make settlement easy to verify, but they also expose a rich trail of metadata. A normal stablecoin payment reveals the sender, receiver, amount, and timing in a single transaction. Once either wallet is connected to a real identity, an observer can reconstruct purchasing habits or merchant cash flow from the public transaction graph.

FZAP explores a different settlement model. Instead of sending funds directly from a buyer to a merchant, it aggregates many payments, redistributes pooled value through temporary wallets and stablecoin routes, then settles merchants together. The aim is not to make the ledger disappear. It is to remove the simplest one-to-one link and force an observer to rely on weaker statistical inference.

![FZAP simulation showing buyers entering a pooled settlement, QAOA-optimised stablecoin hops, simultaneous merchant payouts, convergence, value loss, wallet network, and volatility risk.](/assets/img/fzap/quantum-swap-analysis.png){: width="1200" height="822" }
_Output from the repository's end-to-end simulation: five buyers enter an $80,000 pool, value is redistributed across four hops, and five merchants are settled together._

## The central design

The protocol combines three privacy layers. Each transaction begins with one-time identities, deposits are combined inside a shared settlement round, and the pooled value is moved through several stablecoin and chain transitions before merchants are paid. These layers are deliberately complementary: temporary addresses weaken identity reuse, pooling removes a direct amount correspondence, and intermediate hops make timing and route analysis less deterministic.

<div class="project-flow">
  <div><span>1</span><strong>Deposit</strong><small>Buyer submits a commitment and stablecoins.</small></div>
  <div><span>2</span><strong>Aggregate</strong><small>Payments are locked into one settlement round.</small></div>
  <div><span>3</span><strong>Redistribute</strong><small>Ephemeral wallets split and reroute pooled value.</small></div>
  <div><span>4</span><strong>Settle</strong><small>Merchants are paid together on destination chains.</small></div>
  <div><span>5</span><strong>Verify</strong><small>Flare attestations prove each payout occurred.</small></div>
</div>

## From deposit to verified settlement

### 1. Commitments replace explicit payment instructions

The Solidity pool accepts a USDC deposit alongside a commitment hash derived from the intended merchant, amount, and a private salt. The on-chain record can prove that a commitment was made without publishing the plain buyer-to-merchant mapping. Deposits accumulate under an incrementing pool round until the pool is locked.

### 2. The pool removes one-to-one correspondence

Once a round closes, individual deposits are treated as one total. The Python prototype divides that value across six ephemeral wallets using a random Dirichlet distribution. Each wallet receives a temporary key, a stablecoin, a chain, and a path history. The old wallet keys are overwritten and marked as burned after every redistribution round.

### 3. QAOA searches the routing graph

FZAP models each *stablecoin on a chain* as a graph node. Swap and bridge options become weighted edges. Their cost combines transaction fees, expected slippage, time held, and short-horizon depeg risk. The QAOA pathfinder assigns one qubit to each candidate edge, encodes routing costs into a cost Hamiltonian, and adds penalty terms for flow conservation.

The included simulator uses a depth-two QAOA circuit, three COBYLA restarts, and 2,048 samples from the final state. To keep state-vector simulation tractable, it prunes the graph to at most sixteen edges. That limitation is important: the state space grows exponentially, so the current code is an exploration of the optimisation model rather than evidence of a production quantum advantage.

### 4. Stablecoin routing controls volatility

The routing universe is deliberately limited to stablecoins: USDT, USDC, DAI, FRAX, LUSD, PYUSD, and cUSD. Profiles describe their supported chains, swap and bridge fees, peg behaviour, collateral model, and omnibus-compatible venues. The oracle module models each peg as a mean-reverting process and turns the expected short-horizon deviation into a route risk score.

A separate arbitrage-aware layer scans modeled prices across venues such as Curve, Aave, Maker PSM, and Plasma. When a temporary depeg creates a favorable spread, the router treats it as a negative cost offset. The intention is not speculative profit; it is to recover part of the cost introduced by privacy-enhancing hops.

### 5. Merchants settle simultaneously

After the final hop, the pool converts value back into the settlement asset and constructs merchant payouts with the same timestamp. Simultaneous settlement makes simple timing correlation less useful than it would be if each deposit immediately triggered an individual withdrawal.

### 6. Flare closes the verification loop

Privacy cannot come at the expense of payment correctness. FZAP therefore models a Flare Data Connector workflow: the settlement transaction is submitted for attestation, independent providers verify it against the destination chain, and the finalized result becomes part of a Merkle tree. A merchant—or any other party—can submit the Merkle proof to the pool contract to mark the claim as verified.

The contract only allows a new round after every registered claim is both settled and FDC-verified. This creates a clear lifecycle: deposit, lock, register claims, record payouts, verify proofs, and reset.

## What the prototype demonstrates

<div class="project-metrics">
  <div><strong>$80,000</strong><small>modeled pool value</small></div>
  <div><strong>5 + 5</strong><small>buyers and merchants</small></div>
  <div><strong>4</strong><small>redistribution hops</small></div>
  <div><strong>6</strong><small>wallets per hop</small></div>
  <div><strong>10</strong><small>QAOA qubits in the saved run</small></div>
  <div><strong>≈ 0.18%</strong><small>modeled value loss</small></div>
</div>

In the saved analysis output, the simulated pool moves from $80,000 to roughly $79,856 after four hops. Nine transfers use the modeled zero-fee Plasma route, while fifteen are cross-chain swaps. The numbers are not a live-network benchmark; they show how the implementation measures the privacy-versus-cost trade-off and exposes it rather than hiding it.

![QAOA state probabilities and variational optimisation convergence for the FZAP route solver.](/assets/img/fzap/qaoa-quantum-state.png){: width="1200" height="446" }
_The stored QAOA run uses ten qubits and converges toward a best modeled cost of approximately -5.69 after multiple optimization restarts._

## On-chain responsibilities

| Stage | Contract responsibility |
| --- | --- |
| Deposit | Transfer USDC into the pool and store the buyer's commitment hash. |
| Lock | Close the current round before the off-chain routing process begins. |
| Claim | Record each merchant's expected amount, destination chain, and destination address. |
| Settlement | Attach the destination transaction hash to the corresponding claim. |
| Verification | Resolve Flare's verification contract and validate an FDC Merkle proof. |
| Reset | Start the next round only after every claim has been verified. |

## Prototype boundaries

> **This is a research prototype, not a production payment system.** The repository is useful because it makes its experimental layers visible, but several components still need real-network integration and security review.
{: .prompt-warning }

- The FTSO module currently generates seeded, mean-reverting price histories rather than consuming live oracle feeds.
- The Python FDC path simulates attestation responses and Merkle proofs; the Solidity contract contains the interface for on-chain verification.
- Ephemeral wallet movement and simultaneous settlement are orchestrated off-chain in the model.
- The optional BB84 and quantum-randomness module can use Qiskit, but otherwise falls back to state-vector simulation and is not wired into the main orchestrator.
- The contracts have not been presented as audited, and the repository does not include a production deployment or custody model.
- Privacy improves through unlinkability and batching, but a complete threat model and formal anonymity analysis would still be required.

## What I would build next

1. Connect live FTSO feeds and record the exact data provenance used to price every route.
2. Complete the FDC request, relay, and proof-retrieval path against Coston2 before moving to mainnet.
3. Benchmark the QAOA solver against classical shortest-path and mixed-integer baselines on identical graphs.
4. Add invariant and property tests for conservation of value, claim uniqueness, replay protection, and round transitions.
5. Define a formal adversary model covering amount correlation, timing correlation, colluding merchants, and compromised routing infrastructure.
6. Measure anonymity sets and transaction costs together so routing decisions optimize an explicit privacy budget rather than hop count alone.

## Takeaway

FZAP's most useful idea is architectural: separate the public act of depositing value from the public act of paying a merchant. Pooling, ephemeral wallets, stablecoin-only routing, and independent settlement proofs each solve a different part of that problem. The current repository is an ambitious simulation and contract sketch, but it provides a concrete foundation for testing whether private commercial settlement can remain verifiable without preserving a direct buyer-to-merchant trail.
