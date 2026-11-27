// Small operational rule sets that must be available in the Worker bundle.
// Keep these synchronized with rules/private_tlds.txt, rules/redirect_rules.txt,
// and rules/mullvad_upstream.txt (the latter is now a generic no-ECS geo-bypass list).

export const PRIVATE_TLD_ENTRIES = [
  "internal",
  "lan",
  "home",
] as const;

export const REDIRECT_RULE_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ["www.bilibili.tv", "www.bilibili.tv.w.cdngslb.com"],
  ["upos-sz-mirrorcos.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirrorcosb.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirrorbos.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirrorhw.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirrorhwb.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-upcdnbda2.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-upcdnws.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirrorali.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirroraliov.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirror08h.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["upos-sz-mirrorcosov.bilivideo.com", "upos-hz-mirrorakam.akamaized.net"],
  ["pornhub.com", "www.pornhub.com"],
  ["deo.shopeemobile.com", "deo.shopeemobile.com-v1.edgesuite.net"],
  ["cf.shopee.vn", "cf.shopee.vn.akamaized.net"],
  ["down-vn.img.susercontent.com", "zshopee.v.baishan-cloud.net"],
];

export const GEO_BYPASS_DOMAINS = [
  "x.com",
] as const;

export const FALLBACK_BLOCK_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adservice.google.com",
  "adnxs.com",
] as const;
