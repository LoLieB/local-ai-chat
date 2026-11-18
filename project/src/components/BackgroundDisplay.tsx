import { t, localizeMessage } from "../i18n";
import { useEffect, useState } from "react";
import styles from "../App.module.css";
import {
  BACKGROUND_DISPLAY_INTERVAL_MS,
  getBackgroundOrientation,
  type BackgroundArtwork,
  type BackgroundOrientation
} from "../backgrounds";

type BackgroundDisplayProps = {
  activeBackground: string | null;
  artworks: BackgroundArtwork[];
  isOpen: boolean;
  onApply: (background: string) => void;
  onClose: () => void;
};

export function BackgroundDisplay({
  activeBackground,
  artworks,
  isOpen,
  onApply,
  onClose
}: BackgroundDisplayProps) {
  const initialIndex = Math.max(
    0,
    artworks.findIndex(({ src }) => src === activeBackground)
  );
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [orientation, setOrientation] = useState<BackgroundOrientation>("square");

  useEffect(() => {
    const activeIndex = artworks.findIndex(({ src }) => src === activeBackground);
    if (activeIndex >= 0) {
      setOrientation("square");
      setSelectedIndex(activeIndex);
    }
  }, [activeBackground, artworks]);

  useEffect(() => {
    if (!isOpen || artworks.length < 2) {
      return;
    }

    const rotationTimer = window.setInterval(() => {
      setOrientation("square");
      setSelectedIndex((current) => (current + 1) % artworks.length);
    }, BACKGROUND_DISPLAY_INTERVAL_MS);

    return () => window.clearInterval(rotationTimer);
  }, [artworks.length, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, onClose]);

  const selectedArtwork = artworks[selectedIndex] || artworks[0];
  if (!selectedArtwork) {
    return null;
  }

  const displayOrientationClass = {
    portrait: styles.backgroundDisplayPortrait,
    landscape: styles.backgroundDisplayLandscape,
    square: styles.backgroundDisplaySquare
  }[orientation];
  const previewOrientationClass = {
    portrait: styles.backgroundPreviewPortrait,
    landscape: styles.backgroundPreviewLandscape,
    square: styles.backgroundPreviewSquare
  }[orientation];

  const moveSelection = (direction: number) => {
    setOrientation("square");
    setSelectedIndex((current) => (current + direction + artworks.length) % artworks.length);
  };

  if (!isOpen) {
    return null;
  }

  return (
    <aside
      id="background-display"
      className={`${styles.backgroundDisplay} ${displayOrientationClass}`}
      aria-label={t("Арт-окно фоновых изображений")}
    >
      <header className={styles.backgroundDisplayHeader}>
        <div>
          <span className={styles.sidebarBadge}>{t("Галерея")}</span>
          <strong>{t("Арт-окно")}</strong>
        </div>
        <div className={styles.backgroundDisplayHeaderActions}>
          <span className={styles.backgroundDisplayCount} aria-live="polite">
            {localizeMessage(selectedArtwork.label)} / {artworks.length}
          </span>
          <button
            type="button"
            className={`${styles.ghostButton} ${styles.backgroundDisplayClose}`}
            onClick={onClose}
            aria-label={t("Закрыть арт-окно")}
            title={t("Закрыть")}
          >
            ×
          </button>
        </div>
      </header>

      <figure className={`${styles.backgroundDisplayPreview} ${previewOrientationClass}`}>
        <img
          src={selectedArtwork.src}
          alt={localizeMessage(selectedArtwork.label)}
          draggable={false}
          onLoad={(event) =>
            setOrientation(getBackgroundOrientation(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight))
          }
        />
      </figure>

      <div className={styles.backgroundDisplayMeta}>
        <strong>{localizeMessage(selectedArtwork.label)}</strong>
        <span>{selectedArtwork.src === activeBackground ? t("Активный фон") : t("Автосмена: 25 сек.")}</span>
      </div>

      <div className={styles.backgroundDisplayControls}>
        <button type="button" className={styles.ghostButton} onClick={() => moveSelection(-1)} aria-label={t("Предыдущий фон")}>
          <span className={`${styles.backgroundDisplayArrow} ${styles.backgroundDisplayArrowPrevious}`} aria-hidden="true">
            →
          </span>
        </button>
        <button type="button" className={styles.ghostButton} onClick={() => moveSelection(1)} aria-label={t("Следующий фон")}>
          <span className={styles.backgroundDisplayArrow} aria-hidden="true">
            →
          </span>
        </button>
        <button type="button" className={styles.primaryButton} onClick={() => onApply(selectedArtwork.src)}>{t("Поставить фоном")}{" "}</button>
      </div>
    </aside>
  );
}
