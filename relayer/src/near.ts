// Live ZEC -> SOL price from NEAR Intents' 1Click API, as a dry quote: it
// prices the swap without creating a deposit address or executing anything.
// NEAR Intents runs on mainnet only, so on testnet this is a reference price.

const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";
const ZEC = "nep141:zec.omft.near";
const SOL = "nep141:sol.omft.near";

export interface Quote {
  zecIn: string;
  solOut: string;
  usdIn: string;
  usdOut: string;
  secondsEstimate: number;
}

export async function quoteZecToSol(zats: bigint, solRecipient: string): Promise<Quote> {
  const res = await fetch(QUOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ZEC,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: SOL,
      amount: zats.toString(), // ZEC has 8 decimals, so the amount is in zatoshis
      recipient: solRecipient,
      recipientType: "DESTINATION_CHAIN",
      // A dry quote never refunds; an Intents account avoids inventing a ZEC address.
      refundTo: "snarkcity.near",
      refundType: "INTENTS",
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok || !body.quote) throw new Error(`1Click quote failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  const q = body.quote;
  return { zecIn: q.amountInFormatted, solOut: q.amountOutFormatted, usdIn: q.amountInUsd, usdOut: q.amountOutUsd, secondsEstimate: q.timeEstimate };
}
