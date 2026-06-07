export interface FanOutTarget {
  regionId: number | null;
  regionSlug: string | null;
}

export function makeNonce(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function jobIdSuffix(target: FanOutTarget): string {
  return target.regionSlug === null ? '' : `-r${target.regionId}`;
}

export function buildJobId(
  type: string,
  id: number,
  bucket: number,
  target: FanOutTarget,
  nonce: string,
): string {
  return `${type}:${id}:${bucket}-${nonce}${jobIdSuffix(target)}`;
}
