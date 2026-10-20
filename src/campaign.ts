/**
 * Whether a submission sent at `sentAt` came after the campaign closed. The moment
 * the member sent it counts, not the moment it was processed: Telegram redelivers
 * messages after downtime, and a message sent in time must not be rejected for
 * arriving late.
 */
export function hasEnded(end: Date | undefined, sentAt: Date): boolean {
  return end !== undefined && sentAt.getTime() > end.getTime();
}
