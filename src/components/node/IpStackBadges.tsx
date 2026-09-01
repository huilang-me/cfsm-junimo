// V4/V6 双栈标识：后端下发 ip_v4/ip_v6 标记，"1" 显示、"0" 隐藏。
export function IpStackBadges({
  ipv4,
  ipv6,
}: {
  ipv4?: string | null;
  ipv6?: string | null;
}) {
  const hasIpv4 = isEnabled(ipv4);
  const hasIpv6 = isEnabled(ipv6);
  if (!hasIpv4 && !hasIpv6) return null;
  return (
    <>
      {hasIpv4 ? <span className="ip-stack-badge" data-tag="green">V4</span> : null}
      {hasIpv6 ? <span className="ip-stack-badge" data-tag="green">V6</span> : null}
    </>
  );
}

function isEnabled(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return Boolean(normalized && normalized !== "0" && normalized !== "false" && normalized !== "no");
}
