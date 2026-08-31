/** 供应商页专用开关 —— 详情页头部与每个模型行共用同一个形态。 */
export function Toggle({
  checked,
  onChange
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors ${checked ? "bg-primary" : "bg-border"
        }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5" : "translate-x-0"
          }`}
      />
    </button>
  );
}
