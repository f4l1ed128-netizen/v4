export function cleanRoomName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function parseUserLimit(value) {
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}

export function isOwnerPresent(room, members) {
  return members.some(m => !m.user?.bot && m.id === room.ownerId);
}

export function validSnowflake(value) {
  return typeof value === 'string' && /^\d{16,22}$/.test(value);
}

export function truncate(value, limit = 100) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
