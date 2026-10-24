// Opens a launch's trading pool on Raydium (CPMM, Solana devnet) at the
// auction's clearing price, then burns the LP tokens so the liquidity can
// never be withdrawn. Run after close-launch, once the result is final.
//
//   node scripts/seed-pool.ts <launch.json>
//
// The SOL side is the ZEC raised, priced by a live NEAR Intents quote. NEAR
// Intents is mainnet only, so on devnet the creator's own SOL stands in for
// the swapped ZEC, and the token side comes from the creator's unsold tokens.

import { DEVNET_PROGRAM_ID, getCpmmPdaAmmConfigId, Raydium, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { burn, getAccount, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { fetchLaunch, loadKeypair, program, PROGRAM_ID } from "../src/client.ts";
import { expandHome, publicTerms, readLaunch, writeJson } from "../src/launch-file.ts";
import { quoteZecToSol } from "../src/near.ts";
import { lamportsOf, poolTokens, type PoolRecord } from "../src/pool.ts";

const { BN } = anchor; // the same bn.js the Raydium SDK uses
const path = process.argv[2];
const launch = readLaunch(path);
if (launch.solana.pool) throw new Error(`${launch.name} already has a pool: ${launch.solana.pool.id}`);
const settlement = JSON.parse(readFileSync(path.replace(/\.json$/, ".settlement.json"), "utf8"));
if (!settlement.price) throw new Error(`${launch.name} sold nothing, so there is no price to open a pool at`);

const connection = new Connection(launch.solana.rpc, "confirmed");
const creator = loadKeypair(expandHome(launch.solana.keypair));
const mint = new PublicKey(launch.solana.mint!);
const onChain = await fetchLaunch(program(connection, creator), creator.publicKey, BigInt(launch.solana.launchId!));
if (!onChain.finalized || onChain.root === null) throw new Error(`${launch.name} has no final sale on Solana yet`);

const tokens = poolTokens(BigInt(settlement.raisedZats), settlement.price, launch.sale.decimals);
const quote = await quoteZecToSol(BigInt(settlement.raisedZats), creator.publicKey.toBase58());
const lamports = lamportsOf(quote.solOut);
const held = (await getAccount(connection, getAssociatedTokenAddressSync(mint, creator.publicKey))).amount;
if (held < tokens) throw new Error(`the pool needs ${tokens} base units of ${launch.name}; the creator holds ${held}`);
console.log(`${launch.name}: pool of ${tokens} base units + ${quote.solOut} SOL (${quote.zecIn} ZEC raised, NEAR quote)`);

const raydium = await Raydium.load({ owner: creator, connection, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: "finalized" });
// The SDK's config API lists mainnet addresses; on devnet each config lives at its PDA.
const configs = (await raydium.api.getCpmmConfigs()).map((c) => ({ ...c, id: getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, c.index).publicKey.toBase58() }));
const feeConfig = configs.reduce((a, b) => (b.tradeFeeRate < a.tradeFeeRate ? b : a));
const { execute, extInfo } = await raydium.cpmm.createPool({
  programId: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
  poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
  mintA: { address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: launch.sale.decimals },
  mintB: { address: NATIVE_MINT.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: 9 },
  mintAAmount: new BN(tokens.toString()),
  mintBAmount: new BN(lamports.toString()),
  startTime: new BN(0),
  feeConfig,
  associatedOnly: false,
  ownerInfo: { useSOLBalance: true },
  txVersion: TxVersion.LEGACY,
});
const { txId: createTx } = await execute({ sendAndConfirm: true });
const poolId = extInfo.address.poolId.toBase58();
const lpMint = extInfo.address.lpMint;
console.log(`  pool ${poolId} created: ${createTx}`);

// Burning every LP token locks the liquidity in the pool for good.
const lpAccount = getAssociatedTokenAddressSync(lpMint, creator.publicKey);
const lp = (await getAccount(connection, lpAccount)).amount;
const burnTx = await burn(connection, creator, lpAccount, lpMint, creator, lp);
console.log(`  ${lp} LP tokens burned: ${burnTx}`);

const pool: PoolRecord = { id: poolId, lpMint: lpMint.toBase58(), tokens: tokens.toString(), lamports: lamports.toString(), createTx, burnTx };
launch.solana.pool = pool;
writeJson(path, launch);
writeJson(path.replace(/\.json$/, ".public.json"), publicTerms(launch, PROGRAM_ID.toBase58()));
console.log(`  recorded in ${path} and its public terms`);
