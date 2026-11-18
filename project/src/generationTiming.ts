import { t, getLocale } from "./i18n";
export function generationTiming() {
  const started = performance.now();
  let firstText: number | undefined;
  const counts = new Map<string, number | undefined>();
  return {
    tokens(count?: number, id = "main") { counts.set(id, Number.isSafeInteger(count) && count! >= 0 ? count : undefined); },
    text(value: string) { if (value && firstText === undefined) firstText = performance.now(); },
    finish(streaming: boolean) {
      const ended = performance.now();
      const total = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((ended - started) / 1000);
      const first = streaming && firstText !== undefined ? t("; первый текст через {p0} с", {p0: new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((firstText - started) / 1000)}) : "";
      const tokens = [...counts.values()];
      const speed = tokens.length && tokens.every(value => value !== undefined) && ended - started >= 50
        ? t("; средняя скорость запроса {p0} ток/с", {p0: new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(tokens.reduce<number>((sum, value) => sum + value!, 0) / ((ended - started) / 1000))}) : "";
      return t("Запрос: {p0} с{p1}{p2} (с учётом очереди).", {p0: total, p1: first, p2: speed});
    }
  };
}
