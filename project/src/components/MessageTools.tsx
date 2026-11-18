import { t } from "../i18n";
import type { ReactNode } from "react";
import styles from "../App.module.css";

export function MessageTools({ compact, children }: { compact: boolean; children: ReactNode }) {
  if (!compact) return <>{children}</>;
  return <details className={styles.messageTools} onKeyDown={event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.currentTarget.open = false;
      event.currentTarget.querySelector("summary")?.focus();
    }
  }}>
    <summary>{t("Действия")}</summary>
    <div className={styles.messageToolsContent}>{children}</div>
  </details>;
}
