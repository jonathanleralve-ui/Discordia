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

  // Given a plain-text video URL (YouTube or Vimeo, in any of their common
  // link shapes), return an embeddable iframe URL, or null if it isn't a
  // recognized video link.
  function getVideoEmbedUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');

    if (host === 'youtube.com') {
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        if (id) return `https://www.youtube.com/embed/${id}`;
      }
      const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
      if (shorts) return `https://www.youtube.com/embed/${shorts[1]}`;
      const live = u.pathname.match(/^\/live\/([\w-]+)/);
      if (live) return `https://www.youtube.com/embed/${live[1]}`;
      return null;
    }
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1);
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if (host === 'vimeo.com') {
      const match = u.pathname.match(/^\/(\d+)/);
      return match ? `https://player.vimeo.com/video/${match[1]}` : null;
    }
    return null;
  }

  // Renders `text` into `container` as text nodes with any http(s) URLs
  // turned into clickable links. Returns the embed URL of the first
  // recognized video link found (or null), so the caller can render a
  // player beneath the message.
  function linkifyText(container, text) {
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    let lastIndex = 0;
    let match;
    let embedUrl = null;

    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[0];
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'message-link';
      container.appendChild(a);

      if (!embedUrl) embedUrl = getVideoEmbedUrl(url);

      lastIndex = match.index + url.length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    return embedUrl;
  }

  return { $, $$, initials, escapeHtml, formatTime, avatarEl, avatarWithStatus, applyNameColor, linkifyText, getVideoEmbedUrl };
})();
