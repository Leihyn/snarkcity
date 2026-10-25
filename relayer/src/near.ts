// ZEC -> SOL through NEAR Intents' 1Click API. A dry quote prices the swap
// without creating a deposit address or executing anything; close-launch uses
// it as a reference price, since NEAR Intents runs on mainnet only. A real
// quote (requestSwap) returns a deposit address; sending to it is left to the
// operator's own mainnet wallet. 1Click's ZEC deposit address is transparent,
// so converting the raise makes that one payment's amount public (the bids and
// bidders stay shielded).

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
  // A dry quote never refunds; an Intents account avoids inventing a ZEC address.
  return (await quote(zats, solRecipient, null)).quote;
}

// A real (non-dry) quote: 1Click returns a deposit address that converts
// whatever arrives before the deadline. Nothing is sent here.
export interface Swap { quote: Quote; depositAddress: string; depositMemo?: string; deadline: string }

// zecRefundAddress gets the ZEC back if the swap fails or the deadline passes.
export async function requestSwap(zats: bigint, solRecipient: string, zecRefundAddress: string): Promise<Swap> {
  const q = await quote(zats, solRecipient, { refundTo: zecRefundAddress, refundType: "ORIGIN_CHAIN" });
  if (!q.depositAddress || !q.deadline) throw new Error("1Click returned no deposit address");
  return { quote: q.quote, depositAddress: q.depositAddress, depositMemo: q.depositMemo, deadline: q.deadline };
}

export async function swapStatus(depositAddress: string, depositMemo?: string): Promise<{ status: string; body: unknown }> {
  const url = new URL("https://1click.chaindefuser.com/v0/status");
  url.searchParams.set("depositAddress", depositAddress);
  if (depositMemo) url.searchParams.set("depositMemo", depositMemo);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = (await res.json()) as { status?: string; message?: string };
  if (!res.ok || !body.status) throw new Error(`1Click status failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  return { status: body.status, body };
}

// refund: null for a dry quote; otherwise where a failed swap returns the ZEC.
async function quote(zats: bigint, solRecipient: string, refund: { refundTo: string; refundType: string } | null) {
  const res = await fetch(QUOTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dry: refund === null,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ZEC,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: SOL,
      amount: zats.toString(), // ZEC has 8 decimals, so the amount is in zatoshis
      recipient: solRecipient,
      recipientType: "DESTINATION_CHAIN",
      ...(refund ?? { refundTo: "snarkcity.near", refundType: "INTENTS" }),
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json();
  if (!res.ok || !body.quote) throw new Error(`1Click quote failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  const q = body.quote;
  return {
    quote: { zecIn: q.amountInFormatted, solOut: q.amountOutFormatted, usdIn: q.amountInUsd, usdOut: q.amountOutUsd, secondsEstimate: q.timeEstimate } as Quote,
    depositAddress: q.depositAddress as string | undefined,
    depositMemo: q.depositMemo as string | undefined,
    deadline: q.deadline as string | undefined,
  };
}
