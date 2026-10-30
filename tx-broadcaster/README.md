# tx-broadcaster

Sign and broadcast EVM transactions by giving the tool only three things:
**DATA**, **ABI**, or **HEX**.

| You provide | Mode | What the tool does |
|---|---|---|
| Raw **HEX** of an already-signed tx (`inputs/raw.txt`) | HEX | Verifies/decodes it, then broadcasts. *No private key needed.* |
| Transaction fields incl. hex **DATA** (`inputs/tx.json`) | DATA | Fills nonce/gas/fees from the chain, **signs locally**, broadcasts |
| Contract **ABI** + function + args (`inputs/call.json`) | ABI | Encodes the calldata, signs locally, broadcasts |

Built on [ethers.js v6](https://docs.ethers.org/v6/). Works with Ethereum, BSC,
Polygon, Arbitrum, Base, Optimism (+ testnets) out of the box — or any EVM chain
by chain id + custom RPC.

---

## ⚠️ Read this first (security)

- **Your private key never goes into the repo.** It lives in `tx-broadcaster/.env`
  (gitignored) or is typed with a hidden prompt. The tool never sends it anywhere —
  signing happens locally in memory.
- `npm run check-secrets` scans git-tracked files for key-like material.
  Run it before every push.
- **Rehearse on a testnet first** (`--chain sepolia` — free) and always start a new
  transaction with `--dry-run`, which signs and prints the *exact* bytes that would
  be broadcast, but sends nothing.
- Transactions are **irreversible**. A wrong address or a malicious contract call
  cannot be undone. Read the dry-run output carefully.
- Never enter your seed phrase anywhere. This tool asks only for a single
  private key of a *sending* wallet — ideally a burner with limited funds.

---

## Setup

```bash
cd tx-broadcaster
npm install
cp .env.example .env        # then edit .env: PRIVATE_KEY=0x...
```

Get test funds for practice: Sepolia faucets (e.g. Google Cloud or Alchemy faucet) — search "sepolia faucet".

---

## Usage

```bash
node src/index.js                                   # auto-detect inputs/tx.json | call.json | raw.txt
node src/index.js data --file inputs/tx.json --dry-run
node src/index.js abi  --file inputs/call.json --chain bsc
node src/index.js raw  --file inputs/raw.txt --wait
```

Common options:

| Option | Meaning |
|---|---|
| `--chain <name\|id>` | `ethereum` `sepolia` `bsc` `bsc-testnet` `polygon` `polygon-amoy` `arbitrum` `base` `optimism` … or numeric id (default `ethereum`) |
| `--rpc <url>` | custom RPC (else `RPC_URL` in `.env`, else a free public RPC) |
| `--dry-run` | sign & print everything, **do not broadcast** |
| `--wait` | wait for 1 confirmation after broadcasting |
| `--offline` | sign without network — input must provide `nonce`, `gasLimit`, fees; broadcast later in HEX mode |
| `--force` | skip the mainnet countdown / balance check / chain-id guard |

---

## Input formats

### 1) DATA mode — `inputs/tx.json`

```jsonc
{
  "chain": "ethereum",          // optional, default ethereum
  "to":   "0xYourWallet...",    // recipient
  "value": "0",                 // "0.01" = 0.01 ETH, integer string = wei
  "data": "0x566572696679...",  // your hex payload
  "gasLimit": "30000"           // optional; auto-estimated if omitted
  // optional: "nonce", "gasPrice" (legacy) or "maxFeePerGas"+"maxPriorityFeePerGas"
}
```

### 2) ABI mode — `inputs/call.json`

```jsonc
{
  "chain": "bsc",
  "to": "0x55d398326f99059fF775485246999027B3197955",
  "abi": [ "function transfer(address to, uint256 amount) returns (bool)" ],
  "function": "transfer",
  "args": ["0x000000000000000000000000000000000000dEaD", "1000000"],
  "value": "0"
}
```

The `abi` array accepts human-readable signatures or a full ABI JSON
(can also point to a file with `"abiFile": "inputs/token.abi.json"`).

### 3) HEX mode — `inputs/raw.txt`

One line containing the already-signed raw transaction (`0x02f8…`).
The tool decodes it, shows you the recovered sender, value, data and chain id,
warns if the chain id doesn't match, then broadcasts. **No private key needed.**

---

## Example: sending a DEXTools-style verification message

DEXTools token verification works by publishing a 0-ETH transaction from the
**token deployer wallet** with a text message (hex-encoded) in the `data` field.
`inputs/tx.example.json` already contains the classic payload:

```
Verify your account in Dextools.io
Verification token 8cb9f47a53ebf75efb3b3aa2beb9d381315f72d0
```

Steps:

```bash
cp inputs/tx.example.json inputs/tx.json
# edit inputs/tx.json → set "to" to your deployer wallet (or the address the
# DEXTools verification flow tells you to use), and "chain" to the token's chain
npm run check-secrets
node src/index.js data --dry-run        # review the signed tx — nothing sent
node src/index.js data --wait           # broadcast for real
```

> ⚠️ Phishing warning: the same "Verify your account in Dextools.io" text is also
> used in **scam messages** that lure people to fake sites. DEXTools verification
> is done **by the token deployer, on-chain, from their own wallet** — you never
> have to "connect" or "verify" on a website by giving any key or seed phrase.
> Only trust instructions from the official dextools.io domain / their verified bot.

---

## How it works

```
inputs/*.json|txt ──► encode (ABI mode) ──► fill nonce + gasLimit + fees
                                            from the RPC
                                    ──► sign locally (ethers Wallet, secp256k1)
                                    ──► dry-run? print & stop
                                    ──► eth_sendRawTransaction
                                    ──► tx hash + explorer link (+ --wait receipt)
```

Guards built in:

- signature is verified after signing (recovered `from` must equal your wallet);
- raw-HEX chain id must match the selected chain (else abort unless `--force`);
- balance check before broadcasting (value + max gas cost);
- 5-second countdown on mainnet broadcasts (`--force` skips, testnets skip);
- `npm run check-secrets` keeps key material out of git.

## Repository safety

`.gitignore` excludes `node_modules/`, `.env`, `*.key`, `keystore*.json`.
The `.env.example` is a template — safe to commit; your real `.env` is not.

---

*This tool is for signing **your own** transactions with **your own** keys.
Possessing an address's public data never grants control over it — nothing can
derive a private key from an address, a message, or a hex blob.*
