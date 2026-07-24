// Simple profile edit modal: lets the user change their display name and
// avatar color, similar to Discord's "My Account" panel but pared down to
// the two fields the app actually has.
const Profile = (() => {
  const { $, $$, initials } = Utils;

  // avatar color selection removed
  let selectedAvatarUrl = null;
  let pendingAvatarFile = null;
  let selectedNameColor = null;

  // 3D voice avatar: a zipped MMD model package (.pmx + textures) the user
  // can upload to appear as a 3D lip-synced model in voice channels instead
  // of their flat photo. avatarMode toggles which one is actually used.
  //
  // The model is uploaded to the server as soon as it's picked (rather than
  // deferred until Save) because MMDLoader needs a real URL to resolve the
  // model's texture files against — there's no reliable way to preview
  // straight out of the local .zip before it's been extracted server-side.
  let selectedModelUrl = null;
  let avatarMode = 'flat';
  let modelPreviewInstance = null;

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

  function renderModelSection() {
    const status = $('#edit-profile-model-status');
    const hasModel = !!selectedModelUrl;
    status.textContent = hasModel ? 'A 3D model is set for voice chat' : 'No 3D model uploaded yet';

    $('#edit-profile-model-remove-btn').classList.toggle('hidden', !hasModel);

    const toggle = $('#edit-profile-3d-toggle');
    toggle.checked = avatarMode === '3d';
    toggle.disabled = !hasModel;
    $('#edit-profile-3d-toggle-label').classList.toggle('disabled-label', !hasModel);
  }

  function disposeModelPreview() {
    if (modelPreviewInstance) {
      try { modelPreviewInstance.dispose(); } catch (e) { /* noop */ }
      modelPreviewInstance = null;
    }
    const box = $('#edit-profile-model-preview');
    box.classList.remove('model-preview-loading', 'model-preview-error');
    box.innerHTML = '<span id="edit-profile-model-preview-placeholder">No model</span>';
  }

  function mountModelPreview(modelUrl) {
    disposeModelPreview();
    if (!modelUrl) return;

    const box = $('#edit-profile-model-preview');
    box.innerHTML = '';
    box.classList.add('model-preview-loading');

    if (!window.Avatar3D) {
      // three.js module hasn't finished loading yet — very unlikely, but
      // fail quietly rather than throw.
      box.classList.remove('model-preview-loading');
      box.classList.add('model-preview-error');
      return;
    }

    modelPreviewInstance = window.Avatar3D.createAvatar(box, {
      modelUrl,
      onReady: () => box.classList.remove('model-preview-loading'),
      onError: () => {
        box.classList.remove('model-preview-loading');
        box.classList.add('model-preview-error');
      }
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
    selectedModelUrl = AppState.me.avatarModelUrl || null;
    avatarMode = AppState.me.avatarMode || 'flat';
    renderPhotoPreview();
    renderNameColorSwatches();
    renderModelSection();
    mountModelPreview(selectedModelUrl);

    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#group-settings-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.remove('hidden');
    $('#edit-profile-displayname').focus();
  }

  function closeModal() {
    disposeModelPreview();
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
      Api.auth.updateMe(displayName, undefined, avatarUrl, selectedNameColor, selectedModelUrl, avatarMode)
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
          if (typeof VoiceChat !== 'undefined') VoiceChat.refreshSelfTile();
        })
        .catch((err) => { $('#edit-profile-error').textContent = err.message; });
    };

    const withAvatarUrl = (cb) => {
      if (pendingAvatarFile) {
        $('#edit-profile-error').textContent = 'Uploading image...';
        Api.messages.upload(pendingAvatarFile).then((data) => cb(data.url)).catch((err) => {
          $('#edit-profile-error').textContent = err.message;
        });
      } else {
        cb(selectedAvatarUrl || null);
      }
    };

    withAvatarUrl((avatarUrl) => finalizeSave(avatarUrl));
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

    $('#edit-profile-model-upload-btn').addEventListener('click', () => $('#edit-profile-model-file').click());
    $('#edit-profile-model-remove-btn').addEventListener('click', () => {
      selectedModelUrl = null;
      avatarMode = 'flat';
      renderModelSection();
      disposeModelPreview();
    });
    $('#edit-profile-model-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/\.zip$/i.test(file.name)) {
        $('#edit-profile-error').textContent = 'Please choose a .zip containing your .pmx model and textures';
        return;
      }
      $('#edit-profile-error').textContent = '';
      $('#edit-profile-model-status').textContent = 'Uploading model…';
      Api.avatarModel.upload(file)
        .then((data) => {
          selectedModelUrl = data.modelUrl;
          renderModelSection();
          mountModelPreview(selectedModelUrl);
        })
        .catch((err) => {
          $('#edit-profile-error').textContent = err.message;
          renderModelSection();
        });
    });
    $('#edit-profile-3d-toggle').addEventListener('change', (e) => {
      avatarMode = e.target.checked ? '3d' : 'flat';
    });
  }

  return { initUI };
})();