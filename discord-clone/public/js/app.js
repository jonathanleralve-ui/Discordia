// Bootstrap: rail navigation (Friends home vs a group) and the transition
// from the auth screen into the main app once a session is established.
const App = (() => {
  const { $, $$, initials } = Utils;

  function showFriendsHome() {
    setActiveRail($('#rail-home'));
    $('#sidebar-header').textContent = 'Friends';
    $('#friends-panel').classList.remove('hidden');
    $('#group-panel').classList.add('hidden');
  }

  function setActiveRail(el) {
    $$('.rail-item').forEach((r) => r.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  function enterApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');

    $('#me-name').textContent = AppState.me.displayName;
    const meAvatar = $('#me-avatar');
    meAvatar.style.background = AppState.me.avatarColor;
    meAvatar.textContent = initials(AppState.me.displayName);

    SocketClient.connect();
    VoiceChat.init(AppState.socket, AppState.me);
    initVoiceControls();

    Friends.refresh();
    Groups.refresh();
    showFriendsHome();
  }

  function initVoiceControls() {
    $('#voice-join-btn').addEventListener('click', () => VoiceChat.joinCurrentGroup());
    $('#voice-leave-btn').addEventListener('click', () => VoiceChat.leaveCurrent());
    $('#voice-mute-btn').addEventListener('click', () => VoiceChat.toggleMute());
    $('#voice-share-btn').addEventListener('click', () => VoiceChat.toggleScreenShare());
  }

  function init() {
    $('#rail-home').addEventListener('click', showFriendsHome);
    Auth.initUI();
    Friends.initUI();
    Groups.initUI();
    Chat.initUI();
    Auth.tryResume();
  }

  return { init, enterApp, showFriendsHome, setActiveRail };
})();

App.init();
