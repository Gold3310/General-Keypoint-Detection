#!/usr/bin/env node
'use strict';

/**
 * tx-broadcaster — sign & broadcast EVM transactions from three kinds of input:
 *
 *   HEX   raw.txt / raw.json  → an ALREADY-SIGNED raw transaction → broadcast as-is
 *   DATA  tx.json             → {to, value, data, ...} → tool signs & broadcasts
 *   ABI   call.json           → {to, abi, function, args} → tool encodes, signs, broadcasts
 *
 * The private key is read from .env (PRIVATE_KEY) or typed with a hidden prompt.
 * It is never stored, logged, or transmitted anywhere except to sign locally.
 */

const fs = require('fs');
const path = require('path');
const {
  Wallet, JsonRpcProvider, Transaction, Interface,
  getAddress, isHexString, parseEther, formatEther, toBeHex,
} = require('ethers');

const { resolveChain } = require('./chains');

const TOOL_DIR = path.resolve(__dirname, '..');
const INPUT_DIR = path.join(TOOL_DIR, 'inputs');

// ---------------------------------------------------------------- utilities

const C = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shortErr(e) {
  const msg = (e && (e.shortMessage || e.message)) || String(e);
  return msg.split('\n').slice(0, 2).join(' ').trim();
}

function loadDotEnv() {
  const file = path.join(TOOL_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  const flagsNoValue = new Set(['dry-run', 'wait', 'force', 'offline', 'help', 'h']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (flagsNoValue.has(key)) args[key] = true;
      else args[key] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJson(file) {
  // Tolerates // line comments so users can annotate their input files.
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.replace(/^[ \t]*\/\/.*$/gm, ''));
}

function findFile(spec) {
  const candidates = [spec, path.join(INPUT_DIR, spec), path.join(TOOL_DIR, spec)];
  for (const f of candidates) if (fs.existsSync(f)) return path.resolve(f);
  throw new Error(`File not found: ${spec} (looked in cwd and ${INPUT_DIR})`);
}

/** "0.5" → decimal ETH; "500000000000000000" → wei; "0.5 eth" also ok. */
function parseValue(v) {
  if (v == null || v === '') return 0n;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`Value ${v} is not an integer — use a string like "0.5" (ETH) or "500000" (wei).`);
    return BigInt(v);
  }
  let s = String(v).trim().replace(/\s*(eth|ether)$/i, '').trim();
  if (s === '') return 0n;
  if (s.includes('.')) return parseEther(s);
  if (!/^[0-9]+$/.test(s)) throw new Error(`Cannot parse value "${v}" — use "0.5" (in ETH) or an integer wei string.`);
  return BigInt(s);
}

function truncHex(hex, head = 10, tail = 8) {
  return hex.length > head + tail + 5
    ? `${hex.slice(0, head)}…${hex.slice(-tail)} (${(hex.length - 2) / 2} bytes)`
    : hex;
}

// ------------------------------------------------------------ private key

function normalizePk(pk) {
  pk = String(pk).trim();
  if (pk.startsWith('0x') || pk.startsWith('0X')) pk = pk.slice(2);
  if (!/^[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('PRIVATE_KEY must be exactly 64 hex characters (32 bytes), e.g. 0xabcd…');
  }
  return new Wallet('0x' + pk).privateKey; // validates & normalizes
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return reject(new Error('No private key. Set PRIVATE_KEY in tx-broadcaster/.env (see .env.example).'));
    }
    process.stdout.write(question);
    const chars = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (ch) => {
      const s = ch.toString('utf8');
      if (s === '\r' || s === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(chars.join(''));
      } else if (s === '\u0003') { // Ctrl-C
        process.stdout.write('\n');
        process.exit(130);
      } else if (s === '\u007f' || s === '\b') {
        chars.pop();
      } else {
        chars.push(s);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function requirePrivateKey() {
  if (process.env.PRIVATE_KEY) return normalizePk(process.env.PRIVATE_KEY);
  return normalizePk(await promptHidden('Private key (input hidden, will not be stored): '));
}

// ------------------------------------------------------------------ output

function printTx(dec, rawHex, preset) {
  const line = '-'.repeat(66);
  console.log(C.b('\nSigned transaction'));
  console.log(line);
  console.log(`  hash     ${C.g(dec.hash || '(n/a)')}`);
  console.log(`  from     ${dec.from || '(unknown)'}`);
  console.log(`  to       ${dec.to || '(contract creation)'}`);
  console.log(`  value    ${formatEther(dec.value || 0n)} ${preset.symbol || ''}`);
  if (dec.data && dec.data !== '0x') console.log(`  data     ${truncHex(dec.data)}`);
  console.log(`  nonce    ${dec.nonce}`);
  console.log(`  gasLimit ${dec.gasLimit.toString()}`);
  if (dec.gasPrice) console.log(`  gasPrice ${dec.gasPrice.toString()} wei`);
  if (dec.maxFeePerGas) {
    console.log(`  maxFee   ${dec.maxFeePerGas.toString()} wei  (tip ${dec.maxPriorityFeePerGas} wei)`);
  }
  console.log(`  chainId  ${dec.chainId} (${preset.name})`);
  console.log(`  raw      ${truncHex(rawHex, 24, 12)}`);
  if (preset.explorer && dec.hash) console.log(`  explorer ${preset.explorer}/tx/${dec.hash}`);
  console.log(line);
}

function printRawDecode(dec, preset, rpcChainId) {
  const line = '-'.repeat(66);
  console.log(C.b('\nRaw transaction decoded'));
  console.log(line);
  console.log(`  hash     ${C.g(dec.hash || '(unsigned)')}`);
  console.log(`  from     ${dec.from || '(cannot recover — tx not signed?)'}  ${dec.from ? C.dim('(recovered from signature)') : ''}`);
  console.log(`  to       ${dec.to || '(contract creation)'}`);
  console.log(`  value    ${formatEther(dec.value || 0n)} ${preset.symbol || ''}`);
  if (dec.data && dec.data !== '0x') {
    console.log(`  data     ${truncHex(dec.data)}`);
    try {
      const text = Buffer.from(dec.data.slice(2), 'hex').toString('utf8').replace(/[^\x20-\x7e\n]/g, '·');
      if (/[a-zA-Z]{6,}/.test(text)) console.log(`  as text  ${C.dim(JSON.stringify(text.slice(0, 120)))}`);
    } catch (_) { /* not utf8 */ }
  }
  console.log(`  nonce    ${dec.nonce}   gasLimit ${dec.gasLimit.toString()}`);
  console.log(`  chainId  ${dec.chainId}${rpcChainId && Number(dec.chainId) === rpcChainId ? ` (matches RPC ✓)` : ''}`);
  if (preset.explorer && dec.hash) console.log(`  explorer ${preset.explorer}/tx/${dec.hash}`);
  console.log(line);
}

// ------------------------------------------------------------- core signing

/**
 * Build, sign and (optionally) broadcast a tx from a normalized JSON spec.
 * Works fully offline with --offline if nonce/gasLimit/fees are provided.
 */
async function signAndSend(json, args, ctx) {
  const { provider, wallet, preset } = ctx;
  const from = wallet.address;

  const to = getAddress(String(json.to).trim().toLowerCase());
  const value = parseValue(json.value);
  const data = json.data ?? json.input ?? '0x';
  if (!isHexString(data)) throw new Error(`"data" must be a 0x-prefixed hex string (got ${truncHex(String(data), 20, 0)})`);

  // --- nonce ---
  const nonceHex = json.nonce != null
    ? toBeHex(BigInt(json.nonce))
    : toBeHex(await provider.getTransactionCount(from, 'pending'));

  // --- gas limit ---
  let gasLimit;
  if (json.gasLimit != null) {
    gasLimit = toBeHex(BigInt(json.gasLimit));
  } else {
    try {
      const est = await provider.estimateGas({ from, to, value, data });
      gasLimit = toBeHex((est * 110n) / 100n); // 10% safety buffer
    } catch (e) {
      throw new Error(
        `Gas estimation failed: ${shortErr(e)}\n` +
        `  Common causes: empty wallet, failing contract call, or offline mode.\n` +
        `  Fix: add "gasLimit": "60000" to the input file (a plain 0-ETH data tx needs ~21000–30000).`
      );
    }
  }

  // --- fees ---
  let fees;
  if (json.gasPrice != null) {
    fees = { type: 0, gasPrice: parseValue(json.gasPrice) };
  } else if (json.maxFeePerGas != null || json.maxPriorityFeePerGas != null) {
    fees = {
      type: 2,
      maxFeePerGas: parseValue(json.maxFeePerGas ?? json.maxPriorityFeePerGas),
      maxPriorityFeePerGas: parseValue(json.maxPriorityFeePerGas ?? 0),
    };
  } else if (args.offline) {
    throw new Error('Offline mode needs explicit fees: add "maxFeePerGas"+"maxPriorityFeePerGas" or "gasPrice" to the input file.');
  } else {
    const fd = await provider.getFeeData();
    if (fd.maxFeePerGas && fd.maxPriorityFeePerGas) {
      fees = {
        type: 2,
        maxFeePerGas: (fd.maxFeePerGas * 120n) / 100n,      // 20% headroom
        maxPriorityFeePerGas: fd.maxPriorityFeePerGas,
      };
    } else {
      fees = { type: 0, gasPrice: fd.gasPrice };
    }
  }

  const unsigned = { to, value, data, nonce: nonceHex, gasLimit, chainId: preset.chainId, ...fees };

  // --- balance sanity check (skipped offline) ---
  if (!args.offline && !args.force) {
    const balance = await provider.getBalance(from);
    const maxCost = value + BigInt(gasLimit) * BigInt(fees.maxFeePerGas ?? fees.gasPrice);
    if (balance < maxCost) {
      throw new Error(
        `Wallet balance ${formatEther(balance)} ${preset.symbol} is less than the max cost ` +
        `~${formatEther(maxCost)} ${preset.symbol} (value + gas). Top up the wallet, lower gas, or use --force.`
      );
    }
  }

  const signed = await wallet.signTransaction(unsigned);
  const dec = Transaction.from(signed);
  printTx(dec, signed, preset);

  if (dec.from.toLowerCase() !== from.toLowerCase()) {
    throw new Error(`Internal error: signature recovered ${dec.from} but wallet is ${from}`);
  }

  if (args['dry-run']) {
    console.log(C.y('\n[dry-run] Nothing was broadcast. Re-run without --dry-run to send it.'));
    return null;
  }

  await confirmMainnetIfNeeded(preset, args);
  return broadcast(signed, preset, args);
}

async function broadcast(signedHex, preset, args) {
  const provider = new JsonRpcProvider(args.rpc || preset.rpc, undefined, { batchMaxCount: 1 });
  const resp = await provider.broadcastTransaction(signedHex);
  console.log(C.g(`\n✔ Broadcast accepted — tx hash: ${resp.hash}`));
  if (preset.explorer) console.log(`  track it: ${preset.explorer}/tx/${resp.hash}`);
  if (args.wait) {
    process.stdout.write('  waiting for 1 confirmation…');
    const rcpt = await resp.wait(1);
    console.log(rcpt.status === 1
      ? C.g(` confirmed in block ${rcpt.blockNumber} (status: success)`)
      : C.r(` included in block ${rcpt.blockNumber} but status: FAILED (reverted)`));
  } else {
    console.log(C.dim('  (add --wait to wait for 1 confirmation)'));
  }
  return resp.hash;
}

async function confirmMainnetIfNeeded(preset, args) {
  if (preset.testnet || args.force) return;
  console.log(C.y(`\n⚠  You are about to broadcast on MAINNET (${preset.name}) — this moves REAL funds.`));
  console.log(C.y('   Broadcasting in 5 seconds… press Ctrl-C to cancel (or use --force to skip this delay).'));
  for (let s = 5; s > 0; s--) {
    process.stdout.write(C.y(`   ${s}… `));
    await sleep(1000);
  }
  console.log('');
}

// ------------------------------------------------------------------- modes

async function modeData(json, args, ctx) {
  console.log(C.dim(`DATA mode: ${args.file}`));
  return signAndSend(json, args, ctx);
}

async function modeAbi(json, args, ctx) {
  console.log(C.dim(`ABI mode: ${args.file}`));
  let abi = json.abi;
  if (!abi && json.abiFile) abi = readJson(findFile(json.abiFile));
  if (!abi) throw new Error('ABI mode needs "abi": [...] (or "abiFile": "inputs/my.abi.json") in the input file.');

  const iface = new Interface(abi);
  const fn = json.function ?? json.method;
  if (!fn) throw new Error('ABI mode needs "function": "name" (e.g. "transfer").');
  const fnArgs = json.args ?? [];
  const data = iface.encodeFunctionData(fn, fnArgs);
  console.log(C.dim(`  encoded ${fn}(${fnArgs.join(', ')})`));
  console.log(C.dim(`  calldata ${truncHex(data)}`));

  const spec = {
    to: json.to,
    value: json.value ?? '0',
    data,
    nonce: json.nonce,
    gasLimit: json.gasLimit,
    gasPrice: json.gasPrice,
    maxFeePerGas: json.maxFeePerGas,
    maxPriorityFeePerGas: json.maxPriorityFeePerGas,
  };
  return signAndSend(spec, args, ctx);
}

async function modeRaw(hex, args, ctx) {
  const { preset } = ctx;
  console.log(C.dim(`HEX mode: ${args.file || 'stdin'}`));
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      'Raw input must be complete hex characters "0x…" — it contains invalid characters. ' +
      'Copy the FULL signed transaction (do not copy a shortened/truncated "0x12…cd" preview).'
    );
  }

  const dec = Transaction.from(hex);
  const net = ctx.provider ? await ctx.provider.getNetwork() : null;
  const rpcChainId = net ? Number(net.chainId) : null;
  printRawDecode(dec, preset, rpcChainId);

  if (!dec.from) throw new Error('This hex is not a valid SIGNED transaction (signature missing/corrupt).');

  if (Number(dec.chainId) !== preset.chainId && !args.force) {
    throw new Error(
      `This raw tx is signed for chainId ${dec.chainId}, but you selected ${preset.name} (chainId ${preset.chainId}).\n` +
      `  It would be REJECTED. Fix --chain, or use --force to broadcast anyway.`
    );
  }
  if (!dec.to && !dec.data) throw new Error('Refusing to broadcast an empty tx (no "to" and no data).');

  if (args.offline) {
    console.log(C.y('[offline] Decoded & verified only — nothing broadcast (offline mode has no RPC).'));
    console.log(C.y('          To broadcast: re-run without --offline, or use this hex with DATA/HEX mode online.'));
    return null;
  }
  if (args['dry-run']) {
    console.log(C.y('\n[dry-run] Nothing was broadcast. Re-run without --dry-run to send it.'));
    return null;
  }
  await confirmMainnetIfNeeded(preset, args);
  return broadcast(hex, preset, args);
}

function loadRawHex(args) {
  if (!args.file) throw new Error('HEX mode needs --file <raw.txt|raw.json>');
  const file = findFile(args.file);
  if (/\.json$/i.test(file)) {
    const json = readJson(file);
    return json.raw ?? json.hex ?? json.tx;
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  throw new Error(`${file} has no hex line in it.`);
}

function autoPickFile() {
  const candidates = [
    ['inputs/raw.txt', 'raw'],
    ['inputs/raw.json', 'raw'],
    ['inputs/tx.json', 'data'],
    ['inputs/call.json', 'abi'],
  ];
  for (const [rel, mode] of candidates) {
    const p = path.join(INPUT_DIR, path.basename(rel));
    if (fs.existsSync(p)) return { file: p, mode };
  }
  return null;
}

// -------------------------------------------------------------------- help

function printHelp() {
  console.log(`
${C.b('tx-broadcaster')} — sign & broadcast EVM transactions from DATA, ABI or HEX

${C.b('USAGE')}
  node src/index.js [data|abi|raw] [--file <path>] [options]
  node src/index.js                     auto-detect inputs/tx.json|call.json|raw.txt

${C.b('INPUT MODES')}
  ${C.b('HEX')}   --file inputs/raw.txt    already-SIGNED raw tx → verified & broadcast (no key needed)
  ${C.b('DATA')}  --file inputs/tx.json    {to, value, data} fields → signed with your key
  ${C.b('ABI')}   --file inputs/call.json  {to, abi, function, args} → calldata encoded, then signed

${C.b('OPTIONS')}
  --chain <name|id>   ethereum|sepolia|bsc|bsc-testnet|polygon|polygon-amoy|
                      arbitrum|base|optimism|… or a numeric chain id
                      (default: "chain" in the input file, else ${C.b('ethereum')})
  --rpc <url>         custom RPC endpoint (else RPC_URL in .env, else public RPC)
  --dry-run           sign and print everything, but DO NOT broadcast
  --wait              wait for 1 confirmation after broadcasting
  --offline           sign without any network (input must provide nonce + gasLimit + fees)
  --force             skip balance check / mainnet delay / chain-id mismatch guard
  -h, --help          this help

${C.b('EXAMPLES')}
  1) Preview the DEXTools-style verification tx (signs, shows everything, sends nothing):
       node src/index.js data --file inputs/tx.json --dry-run
  2) Encode an ERC-20 transfer from its ABI and send it on BSC:
       node src/index.js abi --file inputs/call.json --chain bsc
  3) Broadcast a raw signed transaction you got from elsewhere:
       node src/index.js raw --file inputs/raw.txt --wait

${C.b('SECURITY')}
  • The private key lives ONLY in tx-broadcaster/.env (gitignored) or a hidden prompt.
  • npm run check-secrets  → verifies no key-like material is tracked by git.
  • Always rehearse on a testnet (sepolia) and with --dry-run first.
`);
}

// -------------------------------------------------------------------- main

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args._.length === 0) return printHelp();

  let mode = args._[0];
  if (!['data', 'abi', 'raw', 'auto'].includes(mode)) {
    console.error(C.r(`Unknown command "${mode}".`));
    return printHelp();
  }

  if (mode === 'auto') {
    const picked = autoPickFile();
    if (!picked) {
      console.error(C.r('No input file found. Put one of these in tx-broadcaster/inputs/:'));
      console.error('  inputs/raw.txt (HEX mode) | inputs/tx.json (DATA mode) | inputs/call.json (ABI mode)');
      console.error(C.dim('  (copy the .example files and edit them)'));
      return printHelp();
    }
    args.file = picked.file;
    mode = picked.mode;
    console.log(C.dim(`auto-detected ${path.relative(TOOL_DIR, picked.file)} → ${mode.toUpperCase()} mode`));
  } else if (!args.file) {
    const defaults = { raw: 'raw.txt', data: 'tx.json', abi: 'call.json' };
    args.file = path.join(INPUT_DIR, defaults[mode]);
    if (!fs.existsSync(args.file)) {
      throw new Error(`Missing --file. Expected ${args.file} (copy inputs/${defaults[mode]}.example* and edit it).`);
    }
  }

  // ---- input JSON / hex ----
  let json = null;
  let rawHex = null;
  if (mode === 'raw') {
    rawHex = loadRawHex(args);
  } else {
    args.file = findFile(args.file);
    json = readJson(args.file);
  }

  // ---- chain & provider ----
  const preset = resolveChain(args.chain || (json && json.chain) || process.env.CHAIN || 'ethereum');
  const rpc = args.rpc || process.env.RPC_URL || preset.rpc;
  if (!rpc) throw new Error(`No RPC for ${preset.name}. Provide --rpc <url> or set RPC_URL in .env.`);
  console.log(C.dim(`chain: ${preset.name} (chainId ${preset.chainId})   rpc: ${rpc}`));

  const ctx = { preset, provider: null, wallet: null };
  if (!args.offline) ctx.provider = new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });

  if (mode === 'raw') {
    return modeRaw(rawHex, args, ctx);
  }

  ctx.wallet = new Wallet(await requirePrivateKey(), ctx.provider || undefined);
  console.log(C.dim(`wallet: ${ctx.wallet.address}${process.env.PRIVATE_KEY ? '' : ' (key typed at prompt, not stored)'}`));

  if (mode === 'data') return modeData(json, args, ctx);
  return modeAbi(json, args, ctx);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(C.r(`\n✘ ${shortErr(e)}`));
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  });
