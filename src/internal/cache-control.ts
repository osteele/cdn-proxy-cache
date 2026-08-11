export type CacheControl = {
  isPrivate: boolean;
  maxAge?: number;
  mustRevalidate: boolean;
  noCache: boolean;
  noStore: boolean;
  sharedMaxAge?: number;
};

export function parseCacheControl(value: string | undefined): CacheControl {
  const directives = new Map<string, string | true>();
  for (const part of value?.split(',') ?? []) {
    const [rawName, rawValue] = part.trim().split('=', 2);
    if (!rawName) continue;
    directives.set(rawName.toLowerCase(), rawValue?.replace(/^"|"$/g, '') ?? true);
  }

  return {
    isPrivate: directives.has('private'),
    maxAge: parseDeltaSeconds(directives.get('max-age')),
    mustRevalidate: directives.has('must-revalidate'),
    noCache: directives.has('no-cache'),
    noStore: directives.has('no-store'),
    sharedMaxAge: parseDeltaSeconds(directives.get('s-maxage')),
  };
}

export function cacheLifetimeSeconds(cacheControl: CacheControl): number | undefined {
  return cacheControl.sharedMaxAge ?? cacheControl.maxAge;
}

export function canStoreSharedResponse(cacheControl: CacheControl): boolean {
  return !cacheControl.noStore && !cacheControl.isPrivate;
}

function parseDeltaSeconds(value: string | true | undefined): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}
