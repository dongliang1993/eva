// ---------------------------------------------------------------------------
// 记忆卡片共用的展示小件 —— MetaChip 一类,列表与候选卡都用。
// ---------------------------------------------------------------------------

export function MetaChip({
  label,
  value,
  mono = false
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background px-2.5 py-1 text-xs text-muted-foreground ${mono ? "font-mono" : ""
        }`}
      title={value}
    >
      <span className="text-muted-foreground/70">{label}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}
