export function fmtTokensCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${toSigFigs(n / 1e12, 4)}T`;
  if (abs >= 1e9) return `${toSigFigs(n / 1e9, 4)}B`;
  if (abs >= 1e6) return `${toSigFigs(n / 1e6, 4)}M`;
  if (abs >= 1e3) return `${toSigFigs(n / 1e3, 4)}K`;
  return Math.round(n).toString();
}

function toSigFigs(n: number, sig: number): string {
  if (n === 0) return "0";
  const mag = Math.floor(Math.log10(Math.abs(n)));
  const decimals = Math.max(0, sig - mag - 1);
  return n.toFixed(decimals);
}
