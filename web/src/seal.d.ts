// Types for seal.js, which the watcher (TypeScript) imports.
export interface SealedBid {
  commitment: string;
  maxPrice: bigint;
  budget?: bigint;
  refundTo?: string;
}
export declare const DRAND: { chainHash: string; publicKey: string; genesis: number; period: number };
export declare function roundAt(unixSeconds: number): number;
export declare function roundTime(round: number): number;
export declare function sealBid(bid: SealedBid, round: number, crypto?: Crypto): Promise<Uint8Array>;
export declare function sealedRound(memo: Uint8Array | null): number | null;
export declare function openBid(memo: Uint8Array, signatureHex: string, crypto?: Crypto): Promise<SealedBid | null>;
