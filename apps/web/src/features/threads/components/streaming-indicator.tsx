export function StreamingIndicator() {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-sm">
      <span className="animate-bounce [animation-delay:0ms]">.</span>
      <span className="animate-bounce [animation-delay:150ms]">.</span>
      <span className="animate-bounce [animation-delay:300ms]">.</span>
    </span>
  );
}
