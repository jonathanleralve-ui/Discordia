// Simple profile edit modal: lets the user change their display name and
// avatar color, similar to Discord's "My Account" panel but pared down to
// the two fields the app actually has.
const Profile = (() => {
  const { $, $$, initials } = Utils;

  // avatar color selection removed
  let selectedAvatarUrl = null;
  let pendingAvatarFile = null;
  let selectedNameColor = null;

  const NAME_COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];

  function renderNameColorSwatches() {
    const list = $('#edit-profile-namecolor-list');
    list.innerHTML = '';

    const defaultSwatch = document.createElement('div');
    defaultSwatch.className = `color-swatch${selectedNameColor ? '' : ' selected'}`;
    defaultSwatch.style.background = 'var(--text-normal)';
    defaultSwatch.title = 'Default';
    defaultSwatch.addEventListener('click', () => {
      selectedNameColor = null;
      renderNameColorSwatches();
    });
    list.appendChild(defaultSwatch);

    NAME_COLORS.forEach((color) => {
      const swatch = document.createElement('div');
      swatch.className = `color-swatch${selectedNameColor === color ? ' selected' : ''}`;
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', () => {
        selectedNameColor = color;
        renderNameColorSwatches();
      });
      list.appendChild(swatch);
    });
  }

  function renderPhotoPreview() {
    const preview = $('#edit-profile-photo-preview');
    preview.innerHTML = '';
    if (selectedAvatarUrl) {
      const img = document.createElement('img');
      img.src = selectedAvatarUrl;
      img.alt = 'Profile preview';
      preview.appendChild(img);
    } else if (AppState.me?.displayName) {
      preview.textContent = initials(AppState.me.displayName);
    } else {
      preview.textContent = '?';
    }
    $('#edit-profile-remove-photo-btn').classList.toggle('hidden', !selectedAvatarUrl);
  }

  function openModal() {
    $('#edit-profile-error').textContent = '';
    $('#edit-profile-displayname').value = AppState.me.displayName;
    selectedAvatarUrl = AppState.me.avatarUrl || null;
    pendingAvatarFile = null;
    selectedNameColor = AppState.me.nameColor || null;
    renderPhotoPreview();
    renderNameColorSwatches();

    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#group-settings-panel').classList.add('hidden');
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

    const finalizeSave = (avatarUrl) => {
      // Do not send avatarColor (removed from UI) so pass undefined
      Api.auth.updateMe(displayName, undefined, avatarUrl, selectedNameColor)
        .then((data) => {
          Object.assign(AppState.me, data.user);
          $('#me-name').textContent = AppState.me.displayName;
          $('#me-name').style.color = AppState.me.nameColor || '';
          const meAvatar = $('#me-avatar');
          meAvatar.style.background = AppState.me.avatarColor;
          if (AppState.me.avatarUrl) {
            meAvatar.innerHTML = '';
            const img = document.createElement('img');
            img.src = AppState.me.avatarUrl;
            img.alt = AppState.me.displayName;
            meAvatar.appendChild(img);
          } else {
            meAvatar.textContent = initials(AppState.me.displayName);
          }
          closeModal();
        })
        .catch((err) => { $('#edit-profile-error').textContent = err.message; });
    };

    if (pendingAvatarFile) {
      $('#edit-profile-error').textContent = 'Uploading image...';
      Api.messages.upload(pendingAvatarFile)
        .then((data) => {
          finalizeSave(data.url);
        })
        .catch((err) => {
          $('#edit-profile-error').textContent = err.message;
        });
      return;
    }

    finalizeSave(selectedAvatarUrl || null);
  }

  function initUI() {
    $('#edit-profile-btn').addEventListener('click', openModal);
    $('#edit-profile-cancel').addEventListener('click', closeModal);
    $('#edit-profile-close').addEventListener('click', closeModal);
    $('#edit-profile-save').addEventListener('click', save);
    $('#edit-profile-upload-btn').addEventListener('click', () => $('#edit-profile-file').click());
    $('#edit-profile-remove-photo-btn').addEventListener('click', () => {
      selectedAvatarUrl = null;
      pendingAvatarFile = null;
      renderPhotoPreview();
    });
    $('#edit-profile-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      pendingAvatarFile = file;
      const reader = new FileReader();
      reader.onload = () => {
        selectedAvatarUrl = reader.result;
        renderPhotoPreview();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    $('#edit-profile-displayname').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
  }

  return { initUI };
})();
