// Converts a launch's raised ZEC to SOL through NEAR Intents (mainnet only).
// It asks 1Click for a real quote and prints the deposit address and exact
// amount; the operator sends the ZEC from their own mainnet wallet. This
// script never sends funds.
//
//   node scripts/swap-raise.ts <launch.json> <sol-recipient> <zec-refund-address>
//   node scripts/swap-raise.ts --status <deposit-address> [deposit-memo]
//
// The 1Click deposit address for ZEC is transparent: the conversion makes that
// one payment's amount public, never the bids or who placed them.

import { readFileSync } from "node:fs";
import { readLaunch } from "../src/launch-file.ts";
import { requestSwap, swapStatus } from "../src/near.ts";

const args = process.argv.slice(2);
if (args[0] === "--status") {
  const { status } = await swapStatus(args[1], args[2]);
  console.log(`swap to ${args[1]}: ${status}`);
  process.exit(0);
}

const [path, solRecipient, zecRefund] = args;
if (!zecRefund) throw new Error("usage: swap-raise.ts <launch.json> <sol-recipient> <zec-refund-address>");
const launch = readLaunch(path);
const raised = BigInt(JSON.parse(readFileSync(path.replace(/\.json$/, ".settlement.json"), "utf8")).raisedZats);
if (raised === 0n) throw new Error(`${launch.name} raised nothing`);
const swap = await requestSwap(raised, solRecipient, zecRefund);
console.log(`${launch.name}: convert ${swap.quote.zecIn} ZEC raised -> about ${swap.quote.solOut} SOL ($${Number(swap.quote.usdOut).toFixed(2)}) to ${solRecipient}`);
console.log(`  send exactly ${swap.quote.zecIn} ZEC (mainnet) to ${swap.depositAddress}${swap.depositMemo ? ` with memo ${swap.depositMemo}` : ""}`);
console.log(`  before ${swap.deadline}; if the swap fails the ZEC goes back to ${zecRefund}`);
console.log(`  then: node scripts/swap-raise.ts --status ${swap.depositAddress}${swap.depositMemo ? ` ${swap.depositMemo}` : ""}`);
