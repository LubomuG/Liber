const I18n = (() => {
  const dict = {
    uk: {
      login: "Вхід",
      register: "Реєстрація",
      signIn: "Увійти",
      signUp: "Зареєструватись",
      email: "Пошта",
      username: "Нік",
      phone: "Номер телефону",
      password: "Пароль",
      chooseAvatar: "Обрати аватар",
      newDm: "Особистий чат",
      newRoom: "Кімната",
      joinRoom: "Приєднатися",
      leaveRoom: "Вийти з кімнати",
      inviteCode: "Код запрошення",
      shareInvite: "Код для запрошення",
      inviteCreated: "Код запрошення кімнати: ",
      invalid_invite: "Код запрошення не знайдено",
      file_too_large: "Файл завеликий",
      typeMessage: "Повідомлення...",
      search: "Пошук",
      settings: "Налаштування",
      theme: "Тема",
      dark: "Темна",
      light: "Світла",
      style: "Стиль",
      styleGlass: "Матове скло",
      styleNeon: "Неон",
      styleAurora: "Аврора",
      styleSolid: "Класика",
      accent: "Колір акценту",
      language: "Мова",
      background: "Фон чату",
      uploadBackground: "Завантажити фото",
      resetBackground: "Скинути",
      logout: "Вийти",
      close: "Закрити",
      cancel: "Скасувати",
      open: "Відкрити",
      stopSend: "Зупинити й надіслати",
      general: "Загальний чат",
      dmTitle: "Нік користувача",
      roomTitle: "Назва нової кімнати",
      invalid_username: "Нік: 2–20 символів, літери, цифри, . _ -",
      invalid_email: "Некоректна пошта",
      invalid_phone: "Некоректний номер телефону",
      weak_password: "Пароль щонайменше 9 символів",
      avatar_type: "Аватар має бути зображенням",
      exists: "Такий нік, пошта або номер уже зареєстровані",
      invalid_credentials: "Невірна пошта або пароль",
      not_found: "Не знайдено",
      self: "Це ви",
      invalid_name: "Назва: 2–30 символів",
      mic_denied: "Немає доступу до мікрофона або камери",
      upload_failed: "Не вдалося завантажити файл",
      generic: "Щось пішло не так",
    },
    en: {
      login: "Log in",
      register: "Sign up",
      signIn: "Log in",
      signUp: "Create account",
      email: "Email",
      username: "Nickname",
      phone: "Phone number",
      password: "Password",
      chooseAvatar: "Choose avatar",
      newDm: "Direct chat",
      newRoom: "Room",
      joinRoom: "Join room",
      leaveRoom: "Leave room",
      inviteCode: "Invite code",
      shareInvite: "Invite code",
      inviteCreated: "Room invite code: ",
      invalid_invite: "Invite code not found",
      file_too_large: "File is too large",
      typeMessage: "Message...",
      search: "Search",
      settings: "Settings",
      theme: "Theme",
      dark: "Dark",
      light: "Light",
      style: "Style",
      styleGlass: "Frosted glass",
      styleNeon: "Neon",
      styleAurora: "Aurora",
      styleSolid: "Classic",
      accent: "Accent color",
      language: "Language",
      background: "Chat background",
      uploadBackground: "Upload photo",
      resetBackground: "Reset",
      logout: "Log out",
      close: "Close",
      cancel: "Cancel",
      open: "Open",
      stopSend: "Stop and send",
      general: "General chat",
      dmTitle: "User nickname",
      roomTitle: "New room name",
      invalid_username: "Nickname: 2–20 characters, letters, digits, . _ -",
      invalid_email: "Invalid email",
      invalid_phone: "Invalid phone number",
      weak_password: "Password must be at least 9 characters",
      avatar_type: "Avatar must be an image",
      exists: "This nickname, email or phone is already registered",
      invalid_credentials: "Wrong email or password",
      not_found: "Not found",
      self: "That is you",
      invalid_name: "Name: 2–30 characters",
      mic_denied: "No access to microphone or camera",
      upload_failed: "File upload failed",
      generic: "Something went wrong",
    },
  };

  let lang = localStorage.getItem("liber.lang") || "uk";

  const t = (key) => dict[lang][key] || key;

  const apply = () => {
    document.documentElement.lang = lang;
    $("[data-i18n]").each((i, el) => $(el).text(t($(el).attr("data-i18n"))));
    $("[data-i18n-ph]").each((i, el) =>
      $(el).attr("placeholder", t($(el).attr("data-i18n-ph"))),
    );
    $(".js-lang").text(lang.toUpperCase());
  };

  const set = (value) => {
    lang = value;
    localStorage.setItem("liber.lang", lang);
    apply();
  };

  return {
    t,
    apply,
    set,
    get lang() {
      return lang;
    },
  };
})();
$(function () {
  const t = I18n.t;
  const $roomList = $("#roomList");
  const $roomTitle = $("#roomTitle");

  const CIRCLE_MAX_MS = 60000;
  const audioMimes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const videoMimes = ["video/webm;codecs=vp9,opus", "video/webm", "video/mp4"];
  const palette = [
    "#e17076",
    "#7bc862",
    "#e5ca77",
    "#65aadd",
    "#a695e7",
    "#ee7aae",
    "#6ec9cb",
    "#faa774",
  ];

  const state = {
    token: localStorage.getItem("liber.token"),
    me: null,
    socket: null,
    rooms: [],
    active: null,
    unread: {},
    emojis: null,
  };

  const voice = { session: null };
  const circle = { session: null, timer: null };
  let askCallback = null;

  const api = (method, url, data, isForm = false) =>
    $.ajax({
      method,
      url: `/api${url}`,
      data: isForm || !data ? data : JSON.stringify(data),
      contentType: isForm ? false : "application/json",
      processData: false,
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
    });

  const errorText = (xhr) =>
    t((xhr.responseJSON && xhr.responseJSON.error) || "generic");

  const DEFAULT_AVATAR = "./img/default.webp";

  const avatarSrc = (name, avatar, letter = false) => {
    if (avatar) return avatar;
    if (!letter) return DEFAULT_AVATAR;
    const sum = [...name].reduce(
      (total, char) => total + char.charCodeAt(0),
      0,
    );
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">` +
      `<rect width="80" height="80" fill="${palette[sum % palette.length]}"/>` +
      `<text x="40" y="42" fill="#fff" font-size="38" font-family="sans-serif" ` +
      `text-anchor="middle" dominant-baseline="middle">${name[0].toUpperCase()}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  const formatTime = (iso) =>
    new Date(iso).toLocaleTimeString(I18n.lang === "uk" ? "uk-UA" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });

  const scrollDown = () => {
    const box = $("#message")[0];
    box.scrollTop = box.scrollHeight;
  };

  const applyTheme = (theme) => {
    localStorage.setItem("liber.theme", theme);
    $("body").attr("data-theme", theme);
    $("#themeSelect").val(theme).trigger("sync");
  };

  const applyStyle = (style) => {
    localStorage.setItem("liber.style", style);
    $("body").attr("data-style", style);
    $("#styleSelect").val(style).trigger("sync");
  };

  const applyAccent = (accent) => {
    localStorage.setItem("liber.accent", accent);
    $("body").attr("data-accent", accent);
    $("#accentPicker button")
      .removeClass("active")
      .filter(`[data-accent="${accent}"]`)
      .addClass("active");
  };

  const applyBackground = (url) => {
    if (url) localStorage.setItem("liber.bg", url);
    else localStorage.removeItem("liber.bg");
    $("#message").css("background-image", url ? `url("${url}")` : "none");
  };

  const roomTitle = (room) =>
    room.type === "public" ? t("general") : room.name;

  const renderRooms = () => {
    const $list = $roomList.empty();
    state.rooms.forEach((room) => {
      const unread = state.unread[room.id] || 0;
      const $item = $('<li class="room">')
        .toggleClass(
          "active",
          Boolean(state.active) && state.active.id === room.id,
        )
        .data("id", room.id)
        .append(
          $('<img class="avatar" alt="">').attr(
            "src",
            avatarSrc(room.name, room.avatar, room.type !== "dm"),
          ),
          $('<span class="room-name">').text(roomTitle(room)),
        );
      if (unread) $item.append($('<span class="badge">').text(unread));
      $list.append($item);
    });
  };

  const updateRoomHeader = () => {
    if (!state.active) return;
    $roomTitle.text(roomTitle(state.active));
    $("#leaveRoom").toggleClass("hidden", state.active.type !== "group");
    $("#inviteRoom").toggleClass("hidden", state.active.type !== "group" || !state.active.isOwner);
    $("#roomAvatar").attr(
      "src",
      avatarSrc(state.active.name, state.active.avatar, state.active.type !== "dm"),
    );
  };

  const addRoom = (room) => {
    if (!state.rooms.some((item) => item.id === room.id))
      state.rooms.push(room);
    renderRooms();
  };

  const renderContent = (message) => {
    switch (message.kind) {
      case "image":
        return $('<img class="photo" alt="">').attr("src", message.file);
      case "voice":
        return $('<audio controls preload="metadata">').attr(
          "src",
          message.file,
        );
      case "circle":
        return $(
          '<video class="circle" playsinline loop preload="metadata">',
        ).attr("src", message.file);
      default:
        return $('<p class="text">').text(message.text);
    }
  };

  const renderMessage = (message) => {
    const own = message.author.id === state.me.id;
    const $bubble = $('<div class="bubble">').append(
      $('<span class="nick">').text(message.author.username),
      renderContent(message),
      $("<time>").text(formatTime(message.createdAt)),
    );
    return $('<div class="msg">')
      .toggleClass("own", own)
      .append(
        $('<img class="avatar" alt="">').attr(
          "src",
          avatarSrc(message.author.username, message.author.avatar),
        ),
        $bubble,
      );
  };

  const openRoom = async (id, reveal = true) => {
    state.active = state.rooms.find((room) => room.id === id);
    state.unread[id] = 0;
    $("#emojiPanel").addClass("hidden");
    if (reveal) $("#app").addClass("chat-open");
    updateRoomHeader();
    renderRooms();

    const messages = await api("GET", `/rooms/${id}/messages`);
    if (!state.active || state.active.id !== id) return;
    $("#message").empty().append(messages.map(renderMessage));
    scrollDown();
  };

  const loadRooms = async () => {
    state.rooms = await api("GET", "/rooms");
    renderRooms();
    if (state.rooms.length) await openRoom(state.rooms[0].id, false);
  };

  const onMessage = (message) => {
    if (state.active && state.active.id === message.room) {
      $("#message").append(renderMessage(message));
      scrollDown();
      return;
    }
    state.unread[message.room] = (state.unread[message.room] || 0) + 1;
    renderRooms();
  };

  const connectSocket = () => {
    state.socket = io({ auth: { token: state.token } });
    state.socket.on("connect_error", (error) => {
      if (error.message === "unauthorized") logout();
    });
    state.socket.on("message", onMessage);
    state.socket.on("room:new", addRoom);
    state.socket.on("room:updated", (room) => {
      const index = state.rooms.findIndex((item) => item.id === room.id);
      if (index < 0) state.rooms.push(room);
      else state.rooms[index] = room;
      if (state.active?.id === room.id) state.active = room;
      renderRooms();
      updateRoomHeader();
    });
    state.socket.on("room:removed", (id) => {
      state.rooms = state.rooms.filter((room) => room.id !== id);
      delete state.unread[id];
      if (state.active?.id === id) {
        state.active = null;
        $("#message").empty();
        if (state.rooms[0]) openRoom(state.rooms[0].id);
      }
      renderRooms();
    });
  };

  const logout = () => {
    api("POST", "/logout").always(() => location.reload());
    localStorage.removeItem("liber.token");
    if (state.socket) state.socket.disconnect();
  };

  const enterApp = ({ token, user }) => {
    state.token = token;
    state.me = user;
    localStorage.setItem("liber.token", token);
    $("#auth").addClass("hidden");
    $("#app").removeClass("hidden");
    $("#meAvatar").attr("src", avatarSrc(user.username, user.avatar));
    $("#meName").text(user.username);
    connectSocket();
    loadRooms();
  };

  const showAuthError = (xhr) => $("#authError").text(errorText(xhr));

  const LOGO_STATIC = "/img/icon.png";

  const playLogoOnce = () => { $("#logo").attr("src", LOGO_STATIC); };

  const send = (payload) => {
    if (state.active)
      state.socket.emit("message", { roomId: state.active.id, ...payload });
  };

  const uploadFile = async (file, name, purpose = "message", roomId = state.active?.id, kind = "image") => {
    const form = new FormData();
    form.append("file", file, name);
    form.append("purpose", purpose);
    if (purpose === "message") {
      form.append("roomId", roomId);
      form.append("kind", kind);
    }
    const { url } = await api("POST", "/upload", form, true);
    return url;
  };

  const uploadAndSend = async (kind, file, name) => {
    const roomId = state.active?.id;
    if (!roomId) return;
    try {
      const uploadedFile = await uploadFile(file, name, "message", roomId, kind);
      state.socket.emit("message", { roomId, kind, file: uploadedFile });
    } catch {
      alert(t("upload_failed"));
    }
  };

  const startRecording = async (constraints, mimes) => {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const mimeType = mimes.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    const chunks = [];
    recorder.ondataavailable = (event) =>
      event.data.size && chunks.push(event.data);
    const done = new Promise((resolve) => {
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
    });
    recorder.start();
    return { stream, recorder, done };
  };

  const finishCircle = async (shouldSend) => {
    clearTimeout(circle.timer);
    const { session } = circle;
    if (!session) return;
    circle.session = null;
    $("#circleRec").addClass("hidden");
    session.recorder.stop();
    if (shouldSend) await uploadAndSend("circle", await session.done, "circle");
  };

  const loadEmojis = async () => {
    if (state.emojis) return;
    state.emojis = await api("GET", "/emojis");
    renderEmojis("");
  };

  const renderEmojis = (query) => {
    const q = query.trim().toLowerCase();
    const buttons = state.emojis
      .filter((item) => item.name.includes(q))
      .slice(0, 400)
      .map((item) =>
        $('<button type="button" class="emoji">')
          .text(item.char)
          .attr("title", item.name),
      );
    $("#emojiGrid").empty().append(buttons);
  };

  const closeSelects = () => {
    const $all = $(".cs").removeClass("open up");
    $all.find(".csList").addClass("hidden").children().removeClass("focus");
    $all.find(".csTrigger").attr("aria-expanded", "false");
  };

  const enhanceSelect = (element) => {
    const $select = $(element).addClass("native").attr("tabindex", -1);
    const $label = $('<span class="csLabel">');
    const $trigger = $(
      '<button type="button" class="csTrigger" aria-haspopup="listbox" aria-expanded="false">',
    ).append($label);
    const $list = $('<ul class="csList hidden" role="listbox">');
    const $box = $('<div class="cs">').append($trigger, $list);

    const render = () => {
      $label.text($select.find("option:selected").text());
      $list.empty().append(
        $select
          .find("option")
          .map(
            (i, option) =>
              $('<li role="option">')
                .text($(option).text())
                .attr("data-value", option.value)
                .toggleClass("selected", option.selected)[0],
          )
          .get(),
      );
    };

    const pick = (value) => {
      $select.val(value).trigger("change").trigger("sync");
      closeSelects();
    };

    const open = () => {
      closeSelects();
      $list.removeClass("hidden");
      $box.addClass("open");
      $trigger.attr("aria-expanded", "true");
      const space = window.innerHeight - $trigger[0].getBoundingClientRect().bottom;
      $box.toggleClass("up", space < $list.outerHeight() + 16);
    };

    $trigger.on("click", () => {
      if ($list.hasClass("hidden")) open();
      else closeSelects();
    });

    $trigger.on("keydown", (event) => {
      const down = event.key === "ArrowDown";
      const up = event.key === "ArrowUp";
      const isOpen = !$list.hasClass("hidden");

      if (down || up) {
        event.preventDefault();
        if (!isOpen) return open();
        const $items = $list.children();
        const index = $items.index($items.filter(".focus"));
        const next = down
          ? Math.min(index + 1, $items.length - 1)
          : Math.max(index - 1, 0);
        $items.removeClass("focus").eq(next).addClass("focus");
        $items.eq(next)[0].scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && isOpen) {
        const $focused = $list.children(".focus");
        if ($focused.length) {
          event.preventDefault();
          pick($focused.attr("data-value"));
        }
      }
    });

    $list.on("click", "li", function (event) {
      event.preventDefault();
      pick($(this).attr("data-value"));
    });

    $select.on("sync", render).after($box);
    render();
  };

  $(document).on("click", (event) => {
    if (!$(event.target).closest(".cs").length) closeSelects();
  });
  $(document).on("keydown", (event) => {
    if (event.key === "Escape") closeSelects();
  });

  const ask = (titleKey, callback) => {
    askCallback = callback;
    $("#askTitle").text(t(titleKey));
    $("#askInput").val("");
    $("#askModal").removeClass("hidden");
    $("#askInput").focus();
  };

  const safely = (action) => async (value) => {
    try {
      await action(value);
    } catch (xhr) {
      alert(errorText(xhr));
    }
  };

  $(".tabs button").on("click", function () {
    const tab = $(this).data("tab");
    $(".tabs button").removeClass("active");
    $(this).addClass("active");
    $("#loginForm").toggleClass("hidden", tab !== "login");
    $("#registerForm").toggleClass("hidden", tab !== "register");
    $("#authError").text("");
  });

  $("#avatarInput").on("change", function () {
    const file = this.files[0];
    if (file) $("#avatarPreview").attr("src", URL.createObjectURL(file));
  });

  $("#loginForm").on("submit", function (event) {
    event.preventDefault();
    api("POST", "/login", Object.fromEntries(new FormData(this)))
      .then(enterApp)
      .catch(showAuthError);
  });

  $("#registerForm").on("submit", function (event) {
    event.preventDefault();
    api("POST", "/register", new FormData(this), true)
      .then(enterApp)
      .catch(showAuthError);
  });

  $(".js-theme").on("click", () =>
    applyTheme($("body").attr("data-theme") === "dark" ? "light" : "dark"),
  );
  $(".js-lang").on("click", () => applyLang(I18n.lang === "uk" ? "en" : "uk"));

  const applyLang = (lang) => {
    I18n.set(lang);
    $("#langSelect").val(lang);
    $("select").trigger("sync");
    renderRooms();
    updateRoomHeader();
  };

  $roomList.on("click", ".room", function () {
    openRoom($(this).data("id"));
  });

  $("#backBtn").on("click", () => $("#app").removeClass("chat-open"));

  $("#newDm").on("click", () =>
    ask(
      "dmTitle",
      safely(async (username) => {
        const room = await api("POST", "/rooms/dm", { username });
        addRoom(room);
        openRoom(room.id);
      }),
    ),
  );

  $("#newRoom").on("click", () =>
    ask(
      "roomTitle",
      safely(async (name) => {
        const room = await api("POST", "/rooms/group", { name });
        addRoom(room);
        openRoom(room.id);
        window.alert(t("inviteCreated") + room.inviteCode);
      }),
    ),
  );

  $("#joinRoom").on("click", () =>
    ask("inviteCode", safely(async (inviteCode) => {
      const room = await api("POST", "/rooms/join", { inviteCode });
      addRoom(room);
      openRoom(room.id);
    })),
  );

  $("#leaveRoom").on("click", safely(async () => {
    if (!state.active || state.active.type !== "group") return;
    await api("POST", `/rooms/${state.active.id}/leave`);
  }));

  $("#inviteRoom").on("click", safely(async () => {
    if (!state.active || state.active.type !== "group") return;
    const result = await api("POST", `/rooms/${state.active.id}/invite`);
    window.alert(t("inviteCreated") + result.inviteCode);
  }));

  $("#askForm").on("submit", (event) => {
    event.preventDefault();
    const value = $("#askInput").val().trim();
    $("#askModal").addClass("hidden");
    if (value) askCallback(value);
  });

  $("#askCancel").on("click", () => $("#askModal").addClass("hidden"));

  $("#composer").on("submit", (event) => {
    event.preventDefault();
    const text = $("#text").val().trim();
    if (!text) return;
    send({ kind: "text", text });
    $("#text").val("");
  });

  $("#attachBtn").on("click", () => $("#fileInput").click());

  $("#fileInput").on("change", function () {
    const file = this.files[0];
    this.value = "";
    if (file) uploadAndSend("image", file, file.name);
  });

  $("#emojiBtn").on("click", async () => {
    $("#emojiPanel").toggleClass("hidden");
    await loadEmojis();
  });

  $("#emojiSearch").on("input", function () {
    if (state.emojis) renderEmojis($(this).val());
  });

  $("#emojiGrid").on("click", ".emoji", function () {
    $("#text")
      .val((index, value) => value + $(this).text())
      .focus();
  });

  $("#voiceBtn").on("click", async function () {
    if (voice.session) {
      const { session } = voice;
      voice.session = null;
      $(this).removeClass("recording");
      session.recorder.stop();
      await uploadAndSend("voice", await session.done, "voice");
      return;
    }
    try {
      voice.session = await startRecording({ audio: true }, audioMimes);
      $(this).addClass("recording");
    } catch {
      alert(t("mic_denied"));
    }
  });

  $("#circleBtn").on("click", async () => {
    try {
      circle.session = await startRecording(
        { audio: true, video: { facingMode: "user", width: 480, height: 480 } },
        videoMimes,
      );
    } catch {
      alert(t("mic_denied"));
      return;
    }
    $("#circlePreview")[0].srcObject = circle.session.stream;
    $("#circleRec").removeClass("hidden");
    circle.timer = setTimeout(() => finishCircle(true), CIRCLE_MAX_MS);
  });

  $("#circleSend").on("click", () => finishCircle(true));
  $("#circleCancel").on("click", () => finishCircle(false));

  $("#message").on("click", "video.circle", function () {
    if (this.paused) this.play();
    else this.pause();
  });

  $("#message").on("click", ".photo", function () {
    window.open($(this).attr("src"), "_blank");
  });

  $("#settingsBtn").on("click", () =>
    $("#settingsModal").removeClass("hidden"),
  );
  $("#settingsClose").on("click", () => {
    closeSelects();
    $("#settingsModal").addClass("hidden");
  });
  $("#themeSelect").on("change", function () {
    applyTheme($(this).val());
  });
  $("#langSelect").on("change", function () {
    applyLang($(this).val());
  });
  $("#styleSelect").on("change", function () {
    applyStyle($(this).val());
  });
  $("#accentPicker").on("click", "button", function () {
    applyAccent($(this).data("accent"));
  });
  $("#bgUpload").on("click", () => $("#bgInput").click());
  $("#bgReset").on("click", () => applyBackground(null));
  $("#logoutBtn").on("click", logout);

  $("#bgInput").on("change", async function () {
    const file = this.files[0];
    this.value = "";
    if (!file) return;
    try {
      applyBackground(await uploadFile(file, file.name, "background"));
    } catch {
      alert(t("upload_failed"));
    }
  });

  $("select").each((index, element) => enhanceSelect(element));
  applyTheme(localStorage.getItem("liber.theme") || "dark");
  applyStyle(localStorage.getItem("liber.style") || "glass");
  applyAccent(localStorage.getItem("liber.accent") || "blue");
  applyLang(I18n.lang);
  applyBackground(localStorage.getItem("liber.bg"));

  if (state.token) {
    api("GET", "/me")
      .then(enterApp)
      .catch(() => {
        localStorage.removeItem("liber.token");
        state.token = null;
        playLogoOnce();
      });
  } else {
    playLogoOnce();
  }
});
