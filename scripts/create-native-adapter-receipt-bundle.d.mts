export type NativeAdapterReceiptRecord = Readonly<{
  schemaVersion: 1;
  adapterId: "opencode" | "pi" | "grok";
  commitSha: string;
  receiptDigest: string;
}>;

export type NativeAdapterReceiptBundle = Readonly<{
  schemaVersion: 1;
  commitSha: string;
  runner: Readonly<{
    name: string;
    os: string;
    arch: string;
    kernelRelease: string;
    cgroupIdentitySha256: string;
  }>;
  receipts: Readonly<Record<"opencode" | "pi" | "grok", string>>;
  receiptDigest: string;
}>;

export function createNativeAdapterReceiptBundle(input: Readonly<{
  commitSha: string;
  runner: NativeAdapterReceiptBundle["runner"];
  receipts: Readonly<Record<"opencode" | "pi" | "grok", NativeAdapterReceiptRecord>>;
}>): NativeAdapterReceiptBundle;

export function extractReceiptFromEvidence(args: readonly string[]): NativeAdapterReceiptRecord;
export function bundleFromReceipts(args: readonly string[]): NativeAdapterReceiptBundle;
