/** Compact display labels for the app's slot names, matching ESPN's lineup card. */
const SLOT_LABELS: Record<string, string> = {
  SUPER_FLEX: 'OP',
  WRRB_FLEX: 'R/W',
  REC_FLEX: 'W/T',
};

export function fmtSlot(slot: string): string {
  const key = slot.toUpperCase();
  return SLOT_LABELS[key] ?? slot.replace(/_/g, ' ');
}
