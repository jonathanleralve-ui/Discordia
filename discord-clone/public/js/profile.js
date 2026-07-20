// Simple profile edit modal: lets the user change their display name and
// avatar color, similar to Discord's "My Account" panel but pared down to
// the two fields the app actually has.
const Profile = (() => {
  const { $, $$, initials } = Utils;

  const COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];

  let selectedColor = null;

  function renderColors() {
    const wrap = $('#edit-profile-colors');
    wrap.innerHTML = '';
    COLORS.forEach((color) => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch' + (color === selectedColor ? ' selected' : '');
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', () => {
        selectedColor = color;
        renderColors();
      });
      wrap.appendChild(swatch);
    });
  }

  function openModal() {
    $('#edit-profile-error').textContent = '';
    $('#edit-profile-displayname').value = AppState.me.displayName;
    selectedColor = AppState.me.avatarColor;
    renderColors();

    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.remove('hidden');
    $('#edit-profile-displayname').focus();
  }

  function closeModal() {
    $('#edit-profile-panel').classList.add('hidden');
    if (AppState.activeChat) {
      $('#chat-panel').classList.remove('hidden');
    } else {
      $('#empty-state').classList.remove('hidden');
    }
  }

  function save() {
    const displayName = $('#edit-profile-displayname').value.trim();
    $('#edit-profile-error').textContent = '';

    if (!displayName) {
      $('#edit-profile-error').textContent = 'Display name cannot be empty';
      return;
    }

    Api.auth.updateMe(displayName, selectedColor)
      .then((data) => {
        AppState.me = data.user;
        $('#me-name').textContent = AppState.me.displayName;
        const meAvatar = $('#me-avatar');
        meAvatar.style.background = AppState.me.avatarColor;
        meAvatar.textContent = initials(AppState.me.displayName);
        closeModal();
      })
      .catch((err) => { $('#edit-profile-error').textContent = err.message; });
  }

  function initUI() {
    $('#edit-profile-btn').addEventListener('click', openModal);
    $('#edit-profile-cancel').addEventListener('click', closeModal);
    $('#edit-profile-close').addEventListener('click', closeModal);
    $('#edit-profile-save').addEventListener('click', save);
    $('#edit-profile-displayname').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  }

  return { initUI };
})();
