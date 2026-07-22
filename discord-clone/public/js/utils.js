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

  // Given a plain-text video URL, return an embeddable iframe URL, or null
  // if it isn't a recognized video link. Covers YouTube, Vimeo, Twitch
  // (VODs, clips, and live channels), Dailymotion, Streamable, Loom,
  // and Twitter/X (tweet embeds, including any attached video).
  function getVideoEmbedUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    const path = u.pathname;

    if (host === 'youtube.com') {
      if (path === '/watch') {
        const id = u.searchParams.get('v');
        if (id) return `https://www.youtube.com/embed/${id}`;
      }
      const shorts = path.match(/^\/shorts\/([\w-]+)/);
      if (shorts) return `https://www.youtube.com/embed/${shorts[1]}`;
      const live = path.match(/^\/live\/([\w-]+)/);
      if (live) return `https://www.youtube.com/embed/${live[1]}`;
      return null;
    }
    if (host === 'youtu.be') {
      const id = path.slice(1);
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }

    if (host === 'vimeo.com') {
      const match = path.match(/^\/(\d+)/);
      return match ? `https://player.vimeo.com/video/${match[1]}` : null;
    }

    if (host === 'dailymotion.com') {
      const match = path.match(/^\/video\/([\w]+)/);
      return match ? `https://www.dailymotion.com/embed/video/${match[1]}` : null;
    }
    if (host === 'dai.ly') {
      const id = path.slice(1);
      return id ? `https://www.dailymotion.com/embed/video/${id}` : null;
    }

    if (host === 'streamable.com') {
      const id = path.slice(1).split('/')[0];
      return id ? `https://streamable.com/e/${id}` : null;
    }

    if (host === 'loom.com') {
      const match = path.match(/^\/share\/([\w]+)/);
      return match ? `https://www.loom.com/embed/${match[1]}` : null;
    }

    // Twitch requires a `parent` param matching the embedding page's own
    // hostname, or it refuses to load — filled in from the current page.
    if (host === 'twitch.tv') {
      const parent = window.location.hostname;
      const clip = path.match(/\/clip\/([\w-]+)/);
      if (clip) return `https://clips.twitch.tv/embed?clip=${clip[1]}&parent=${parent}`;
      const vod = path.match(/^\/videos\/(\d+)/);
      if (vod) return `https://player.twitch.tv/?video=${vod[1]}&parent=${parent}`;
      const channel = path.match(/^\/([a-zA-Z0-9_]+)\/?$/);
      if (channel) return `https://player.twitch.tv/?channel=${channel[1]}&parent=${parent}`;
      return null;
    }
    if (host === 'clips.twitch.tv') {
      const slug = path.slice(1).split('/')[0];
      return slug ? `https://clips.twitch.tv/embed?clip=${slug}&parent=${window.location.hostname}` : null;
    }

    // Twitter/X: the tweet id is all we need — this is the same embed
    // endpoint their own widgets.js script loads into an iframe, so it
    // renders (including any attached video) without that script.
    if (host === 'twitter.com' || host === 'x.com') {
      const tweet = path.match(/\/status\/(\d+)/);
      return tweet ? `https://platform.twitter.com/embed/Tweet.html?id=${tweet[1]}` : null;
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

  // A message counts as "emoji-only" when, once whitespace is stripped, it's
  // made up entirely of emoji characters (plus their variation-selector/ZWJ
  // modifiers) and there aren't too many of them — mirrors how Discord/Slack
  // only "jumbo" a handful of emoji, not a wall of them.
  const EMOJI_ONLY_REGEX = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)+$/u;
  const EMOJI_ONLY_MAX_LENGTH = 24;

  function isEmojiOnly(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length > EMOJI_ONLY_MAX_LENGTH) return false;
    return EMOJI_ONLY_REGEX.test(trimmed);
  }

  return { $, $$, initials, escapeHtml, formatTime, avatarEl, avatarWithStatus, applyNameColor, linkifyText, getVideoEmbedUrl, isEmojiOnly };
})();
