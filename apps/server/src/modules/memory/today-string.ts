/** YYYY-MM-DD 本地日期。所有"今天"的日记定位都从这里取,保持单一来源。 */
export const todayString = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
