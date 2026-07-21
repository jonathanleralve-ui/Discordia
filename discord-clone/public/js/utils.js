// Small DOM query and formatting helpers shared by every other module.
const Utils = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(iso) {
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z');
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function avatarEl(user, size = '') {
    const el = document.createElement('div');
    el.className = `avatar ${size}`;
    el.style.background = user.avatarColor || user.senderColor || '#5865F2';
    if (user.avatarUrl) {
      el.innerHTML = '';
      const img = document.createElement('img');
      img.src = user.avatarUrl;
      img.alt = user.displayName || user.senderName || 'avatar';
      el.appendChild(img);
    } else {
      el.textContent = initials(user.displayName || user.senderName);
    }
    return el;
  }

  function avatarWithStatus(user) {
    // Status dot removed: return plain avatar element only
    return avatarEl(user);
  }

  function applyNameColor(el, color) {
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      el.style.color = color;
    }
  }

  return { $, $$, initials, escapeHtml, formatTime, avatarEl, avatarWithStatus, applyNameColor };
})();
