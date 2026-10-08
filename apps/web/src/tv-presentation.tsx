import type { TvIdentity, TvPlatform } from '@remote-webos-tv/contracts';

export function tvPlatformLabel(platform: TvPlatform, identity: TvIdentity | undefined): string {
  const name = platform === 'tizen' ? 'Tizen' : 'webOS';
  return identity?.platformVersion ? `${name} ${identity.platformVersion}` : name;
}

export function TvBrand({ platform, className }: { platform: TvPlatform; className?: string }) {
  return platform === 'tizen' ? <span className={className}>Samsung</span> : <img className={className} src="/lg-logo.svg" alt="LG" />;
}
