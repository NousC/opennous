/**
 * Compute connection strength label from a contact's score and last activity date.
 * Used in both the list endpoint and the detail endpoint — defined once here.
 */
export function connLabel(score, lastAt) {
  if (!lastAt) return 'Weak';
  const days = (Date.now() - new Date(lastAt)) / 86400000;
  if (days <= 14 && score >= 40) return 'Strong';
  if (days <= 60 && score >= 10) return 'Medium';
  return 'Weak';
}
