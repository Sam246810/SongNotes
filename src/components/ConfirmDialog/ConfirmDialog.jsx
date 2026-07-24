import styles from './ConfirmDialog.module.css';

/**
 * Generic confirm/info modal, reused for the DAW-audio-loss warnings (sign-out gate,
 * beforeunload-cancelled follow-up). Two shapes:
 *
 *   Two-button (confirm/cancel): pass cancelLabel + onCancel alongside confirmLabel + onConfirm.
 *   Single-button (info/dismiss): omit cancelLabel/onCancel — only the confirm button renders,
 *                                  e.g. confirmLabel="Got it".
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel,
  onConfirm,
  onCancel,
  danger = false,
  confirmId,
  cancelId,
}) {
  const hasCancel = Boolean(cancelLabel && onCancel);

  return (
    <div className={styles.overlay} onClick={onCancel || onConfirm}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2 className={styles.modalTitle}>{title}</h2>
        <p className={styles.modalText}>{message}</p>
        <div className={styles.modalActions}>
          {hasCancel && (
            <button className={styles.cancelBtn} onClick={onCancel} id={cancelId}>
              {cancelLabel}
            </button>
          )}
          <button
            className={danger ? styles.confirmBtn : styles.confirmBtnPositive}
            onClick={onConfirm}
            id={confirmId}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
