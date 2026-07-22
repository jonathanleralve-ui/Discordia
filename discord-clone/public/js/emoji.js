// A small self-contained emoji picker: no external library or network
// request, just a curated list grouped into a few categories, rendered into
// a popup panel that inserts the picked emoji at the cursor in #chat-input.
const EmojiPicker = (() => {
  function $(sel) { return document.querySelector(sel); }

  const CATEGORIES = [
    {
      label: 'Smileys',
      icon: '😀',
      emojis: ['😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😍',
               '🥰', '😘', '😋', '😜', '🤪', '🤨', '🧐', '😎', '🥳', '🤔',
               '😐', '😴', '😪', '😷', '🤒', '🥵', '🥶', '😭', '😤', '😡',
               '🤬', '😱', '😨', '🥺', '😳', '🙄', '😬', '🤯', '🥱', '😵']
    },
    {
      label: 'Gestures',
      icon: '👍',
      emojis: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👋', '🤙', '💪',
               '🙏', '👏', '🤝', '👊', '✊', '🤛', '🤜', '👉', '👈', '👆',
               '👇', '☝️', '✋', '🖐️', '🖖', '🤌', '🤙', '💅', '🫡', '🙌']
    },
    {
      label: 'Animals',
      icon: '🐶',
      emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
               '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦉',
               '🐴', '🦄', '🐝', '🦋', '🐢', '🐍', '🦖', '🐙', '🐳', '🐬']
    },
    {
      label: 'Food',
      icon: '🍕',
      emojis: ['🍏', '🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍒', '🥑',
               '🍕', '🍔', '🍟', '🌭', '🥪', '🌮', '🌯', '🍣', '🍜', '🍩',
               '🍪', '🎂', '🍫', '🍿', '☕', '🍵', '🍺', '🍷', '🥤', '🍦']
    },
    {
      label: 'Activities',
      icon: '⚽',
      emojis: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎮', '🎲', '🎯', '🎳',
               '🎸', '🎧', '🎤', '🎨', '🚀', '🚗', '✈️', '🏆', '🥇', '🎉']
    },
    {
      label: 'Hearts',
      icon: '❤️',
      emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
               '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '⭐', '🔥']
    }
  ];

  let onPick = null;
  let activeCategory = 0;

  function renderTabs() {
    const tabs = $('#emoji-picker-tabs');
    tabs.innerHTML = '';
    CATEGORIES.forEach((cat, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `emoji-picker-tab${i === activeCategory ? ' active' : ''}`;
      btn.textContent = cat.icon;
      btn.title = cat.label;
      btn.addEventListener('click', () => {
        activeCategory = i;
        renderTabs();
        renderGrid();
      });
      tabs.appendChild(btn);
    });
  }

  function renderGrid() {
    const grid = $('#emoji-picker-grid');
    grid.innerHTML = '';
    CATEGORIES[activeCategory].emojis.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-picker-item';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        if (onPick) onPick(emoji);
      });
      grid.appendChild(btn);
    });
  }

  function isOpen() {
    return !$('#emoji-picker').classList.contains('hidden');
  }

  function open() {
    renderTabs();
    renderGrid();
    $('#emoji-picker').classList.remove('hidden');
  }

  function close() {
    $('#emoji-picker').classList.add('hidden');
  }

  function toggle() {
    if (isOpen()) close(); else open();
  }

  function init(pickHandler) {
    onPick = pickHandler;

    $('#chat-emoji-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });

    document.addEventListener('click', (e) => {
      const wrapper = document.querySelector('.emoji-picker-wrapper');
      if (isOpen() && wrapper && !wrapper.contains(e.target)) close();
    });
  }

  return { init, close };
})();
