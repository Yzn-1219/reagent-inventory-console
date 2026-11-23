/* ============================================================
   试剂出入库管理台 · 数据层
   云端为唯一真相源，本地 localStorage 仅作离线只读缓存。
   ============================================================ */
(function () {
  'use strict';

  /* publicConfig —— 由云服务开通时下发，原样内联，勿改 */
  var PUBLIC_CONFIG = {
    endpoint: 'https://reagent-io.app.workbuddy.host',
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_g7osakflgNymC1zReuSO7B_Ewb2ruHR4SP2mR5Cbib6cAjYx0VBlsK3'
  };

  var cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: PUBLIC_CONFIG.endpoint,
    oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
    publishableKey: PUBLIC_CONFIG.publishableKey
  });

  var LS_TEAM = 'rio_team_id';
  var LS_CACHE = 'rio_cache_';
  var LS_ACCT = 'rio_acct';           // 本机账号（手机号 + 密码校验值）
  var LS_UNLOCK = 'rio_unlock_until'; // 记住我：免密解锁到什么时候
  var LS_SKIP = 'rio_acct_skip';      // 用户选择「以后再说」
  var LS_LASTPHONE = 'rio_last_phone'; // 上次登录的手机号，用于预填

  var DEFAULTS = {
    categories: ['有机溶剂', '无机盐', '酸碱', '标准品', '对照品', '显色剂', '指示剂', '生化试剂', '危化品', '其他'],
    units: ['瓶', 'mL', 'L', 'g', 'mg', 'kg', '支', '包', '盒', 'μL'],
    locations: ['试剂柜 A', '试剂柜 B', '4℃ 冰箱', '-20℃ 冰箱', '通风橱', '危化品专柜', '实验台'],
    expiryWarnDays: 30
  };

  var S = {
    ready: false,
    booting: true,
    session: null,
    user: null,
    account: null,
    phone: '',              // 当前登录手机号（用户名即手机号）
    unlocked: false,
    sessionMissing: true,   // 已确认本地没有可用云端会话
    team: null,
    role: '',
    isAdmin: false,
    teams: [],
    settings: {},
    reagents: [],
    batches: [],
    txns: [],
    roster: [],
    members: [],            // list_members 结果（含手机号）
    requests: [],           // 管理员可见的加入申请
    myJoins: [],            // 我发出过的加入申请（多小组用）
    myReq: null,            // 我自己最近一条申请
    pendingJoin: null,      // 正在等待审批的小组信息
    status: 'idle',      // idle | syncing | offline | error
    errorMsg: '',
    lastSync: 0,
    view: 'overview',
    listeners: []
  };

  /* ---------- 工具 ---------- */
  function on(fn) { S.listeners.push(fn); }
  function emit() { S.listeners.forEach(function (fn) { try { fn(S); } catch (e) { console.error(e); } }); }
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
  function round(v) { return Math.round(n(v) * 1000) / 1000; }
  function todayStr() {
    var d = new Date(), p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  /* 默认批号：年月日（20261122） */
  function lotToday() {
    var d = new Date(), p = function (x) { return String(x).padStart(2, '0'); };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  function uid(prefix) {
    return (prefix || 'r') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function msg(e) {
    if (!e) return '未知错误';
    return e.message || e.error_description || e.msg || String(e);
  }

  /* ---------- 手机号工具 ----------
     手机号就是用户名，一个手机号 = 一个身份，换设备也是同一个人。
     -------------------------------------------------- */
  function normPhone(v) {
    var t = String(v == null ? '' : v).replace(/[^\d+]/g, '');
    t = t.replace(/^\+/, '');
    if (t.slice(0, 2) === '86' && t.length > 11) t = t.slice(2);
    return /^1\d{10}$/.test(t) ? t : '';
  }
  function maskPhone(p) {
    var t = normPhone(p) || String(p || '');
    return /^1\d{10}$/.test(t) ? t.slice(0, 3) + '****' + t.slice(7) : t;
  }

  /* ---------- 本机账号（手机号 + 密码） ----------
     手机号是唯一身份；密码用 PBKDF2 拉伸后只在本机存校验值，不上传、不可逆。
     新注册的账号会顺带把密码写进云端，所以换设备也能直接手机号 + 密码登录。
     老账号（早期只收过验证码的）可走「忘记密码」把密码补到云端。
     -------------------------------------------------- */
  function toHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }
  function fromHex(h) {
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function randHex(len) {
    var b = new Uint8Array(len);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(b);
    else for (var i = 0; i < len; i++) b[i] = Math.floor(Math.random() * 256);
    return toHex(b);
  }
  function fallbackHash(password, saltHex, iter) {
    var s = saltHex + '|' + password, h = 0x811c9dc5, rounds = Math.max(2000, Math.floor(iter / 8));
    for (var r = 0; r < rounds; r++) {
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      }
      h = (h ^ (h >>> 13)) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8) + saltHex.slice(0, 24);
  }
  function derive(password, saltHex, iter) {
    var c = window.crypto, subtle = c && c.subtle;
    if (subtle && subtle.importKey && window.TextEncoder) {
      try {
        return subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits'])
          .then(function (key) {
            return subtle.deriveBits({ name: 'PBKDF2', salt: fromHex(saltHex), iterations: iter, hash: 'SHA-256' }, key, 256);
          })
          .then(toHex)
          .catch(function () { return fallbackHash(password, saltHex, iter); });
      } catch (e) { /* 落到兜底 */ }
    }
    return Promise.resolve(fallbackHash(password, saltHex, iter));
  }

  function readAccount() {
    try {
      var raw = localStorage.getItem(LS_ACCT);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o) return null;
      /* 兼容早期版本：以前存的是 u（自定义用户名），现在统一换成手机号 */
      if (!o.phone && o.ident && normPhone(o.ident)) o.phone = normPhone(o.ident);
      return o && o.phone && o.hash ? o : null;
    } catch (e) { return null; }
  }
  function skipSetup() {
    try { return localStorage.getItem(LS_SKIP) === '1'; } catch (e) { return false; }
  }
  function setSkip(v) {
    try { if (v) localStorage.setItem(LS_SKIP, '1'); else localStorage.removeItem(LS_SKIP); } catch (e) { }
  }
  function readLastPhone() {
    try { return localStorage.getItem(LS_LASTPHONE) || ''; } catch (e) { return ''; }
  }
  function saveLastPhone(p) {
    try { if (p) localStorage.setItem(LS_LASTPHONE, p); } catch (e) { }
  }

  /* cloudPwd=true 表示这组密码在云端也有效（换设备可直接登录） */
  function saveAccount(phone, password, name, cloudPwd) {
    var salt = randHex(16), iter = 60000;
    var pn = normPhone(phone) || String(phone || '');
    return derive(password, salt, iter).then(function (hash) {
      var acc = {
        phone: pn, name: name || '', salt: salt, iter: iter, hash: hash,
        cloudPwd: !!cloudPwd, at: Date.now()
      };
      try { localStorage.setItem(LS_ACCT, JSON.stringify(acc)); localStorage.removeItem(LS_SKIP); } catch (e) { }
      try { localStorage.setItem(LS_LASTPHONE, pn); } catch (e) { }
      S.account = acc;
      S.phone = pn;
      emit();
      return acc;
    });
  }
  function checkPassword(phone, password) {
    var acc = S.account || readAccount();
    if (!acc) return Promise.resolve(false);
    var pn = normPhone(phone);
    if (pn && acc.phone && pn !== acc.phone) return Promise.resolve(false);
    return derive(password, acc.salt, acc.iter).then(function (h) { return h === acc.hash; });
  }
  function markCloudPwd() {
    var acc = S.account || readAccount();
    if (!acc) return;
    acc.cloudPwd = true;
    try { localStorage.setItem(LS_ACCT, JSON.stringify(acc)); } catch (e) { }
    S.account = acc;
  }
  function clearAccount() {
    try { localStorage.removeItem(LS_ACCT); localStorage.removeItem(LS_UNLOCK); localStorage.removeItem(LS_SKIP); } catch (e) { }
    S.account = null; S.unlocked = false;
    emit();
  }
  function unlock(days) {
    var until = days ? Date.now() + days * 86400000 : 0;
    try {
      if (until) localStorage.setItem(LS_UNLOCK, String(until));
      else localStorage.removeItem(LS_UNLOCK);
    } catch (e) { }
    S.unlocked = true;
  }
  function isUnlocked() {
    if (S.unlocked) return true;
    try {
      var u = Number(localStorage.getItem(LS_UNLOCK) || 0);
      if (u > Date.now()) { S.unlocked = true; return true; }
    } catch (e) { }
    return false;
  }
  function lockScreen() {
    S.unlocked = false;
    try { localStorage.removeItem(LS_UNLOCK); } catch (e) { }
    emit();
  }

  /* ---------- 设置 ---------- */
  function settings() {
    var s = S.settings || {};
    return {
      categories: Array.isArray(s.categories) && s.categories.length ? s.categories : DEFAULTS.categories,
      units: Array.isArray(s.units) && s.units.length ? s.units : DEFAULTS.units,
      locations: Array.isArray(s.locations) ? s.locations : DEFAULTS.locations,
      expiryWarnDays: s.expiryWarnDays || DEFAULTS.expiryWarnDays
    };
  }

  /* ---------- 缓存 ---------- */
  function cacheKey() { return LS_CACHE + (S.team ? S.team.id : 'none'); }
  function saveCache() {
    if (!S.team) return;
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({
        reagents: S.reagents, batches: S.batches, txns: S.txns,
        roster: S.roster, settings: S.settings, at: Date.now()
      }));
    } catch (e) { /* 配额满时忽略 */ }
  }
  function loadCache() {
    if (!S.team) return false;
    try {
      var raw = localStorage.getItem(cacheKey());
      if (!raw) return false;
      var o = JSON.parse(raw);
      S.reagents = o.reagents || [];
      S.batches = o.batches || [];
      S.txns = o.txns || [];
      S.roster = o.roster || [];
      S.settings = o.settings || {};
      S.lastSync = o.at || 0;
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 认证 ----------
     两条通道：
     ① 手机号 + 密码  —— 日常登录，秒进，跨设备可用（前提是云端有这组密码）
     ② 手机号 + 验证码 —— 首次注册 / 新设备 / 忘记密码
     -------------------------------------------------- */
  function applySession(data) {
    S.session = data || null;
    S.user = data && data.user ? data.user : null;
    var ph = '';
    if (S.user) {
      ph = normPhone(S.user.phone || '');
      if (!ph && S.user.raw) ph = normPhone(S.user.raw.phone_number || '');
    }
    if (ph) { S.phone = ph; S.sessionMissing = false; }
    return S.session;
  }

  function sendOtp(phone) {
    var pn = normPhone(phone);
    if (!pn) return Promise.reject(new Error('请输入正确的 11 位手机号'));
    return cloud.auth.sendOtp({ phone: pn }).then(function (res) {
      if (res.error) throw res.error;
      return res.data;
    });
  }

  function verifyOtp(payload) {
    var p = {
      verificationId: payload.verificationId,
      token: payload.token,
      phone: normPhone(payload.phone) || payload.phone,
      isExistingUser: !!payload.isExistingUser
    };
    if (payload.password) p.password = payload.password;
    return cloud.auth.verifyOtp(p).then(function (res) {
      if (res.error) throw res.error;
      applySession(res.data);
      S.sessionMissing = false;
      if (!S.phone) { S.phone = normPhone(payload.phone); }
      return res.data;
    });
  }

  /* 手机号 + 密码直接登录（云端校验） */
  function signInPassword(phone, password) {
    var pn = normPhone(phone);
    return cloud.auth.signInWithPassword({ phone: pn, password: password }).then(function (res) {
      if (res.error) throw res.error;
      applySession(res.data);
      S.sessionMissing = false;
      S.phone = pn;
      return res.data;
    });
  }

  function getSession() {
    return cloud.auth.getSession().then(function (res) {
      if (res.error) return null;
      applySession(res.data);
      if (res.data) S.sessionMissing = false;
      return S.session;
    });
  }

  /* 给已有账号补设云端密码：手机号 + 短信验证码 → 重设密码。
     provider 不一定支持手机号走重置通道，失败时由上层降级成本机密码。 */
  function cloudPwdStart(phone) {
    var auth = cloud.auth;
    if (!auth || typeof auth.request !== 'function') return Promise.reject(new Error('当前环境不支持自助设密码'));
    var pn = normPhone(phone);
    if (!pn) return Promise.reject(new Error('请输入正确的手机号'));
    return auth.request('/v1/verification', {
      method: 'POST',
      body: { phone_number: pn, usage: 'PASSWORD_RESET', target: 'USER' }
    }).then(function (r) {
      if (r && r.error) throw r.error;
      var vid = r && r.data && r.data.verification_id;
      if (!vid) throw new Error('云端未返回验证编号');
      return vid;
    });
  }
  function cloudPwdConfirm(vid, code, newPwd, phone) {
    var auth = cloud.auth;
    if (!auth || typeof auth.request !== 'function') return Promise.reject(new Error('当前环境不支持自助设密码'));
    var pn = normPhone(phone);
    return auth.request('/v1/verification/verify', {
      method: 'POST',
      body: { verification_id: vid, verification_code: String(code || '').trim() }
    }).then(function (r) {
      if (r && r.error) throw r.error;
      var tk = r && r.data && r.data.verification_token;
      if (!tk) throw new Error('验证码不正确或已失效');
      return auth.request('/v1/reset', {
        method: 'POST',
        body: { phone_number: pn, new_password: newPwd, verification_token: tk }
      });
    }).then(function (r) {
      if (r && r.error) throw r.error;
      return true;
    });
  }

  /* 已登录状态下把密码写进云端（换设备可直接手机号 + 密码登录）。
     provider 若要求 sudo_token 会失败，失败就静默保持「本机密码」。 */
  function trySyncCloudPwd(newPwd) {
    var auth = cloud.auth;
    if (!auth || typeof auth.request !== 'function' || typeof auth.getAccessToken !== 'function') {
      return Promise.resolve(false);
    }
    return auth.getAccessToken().then(function (tk) {
      if (!tk) return false;
      return auth.request('/v1/user/password', {
        method: 'PATCH', token: tk, body: { new_password: newPwd }
      }).then(function (r) { return !(r && r.error); });
    }).catch(function () { return false; });
  }

  function signOut() {
    return cloud.auth.signOut().then(function () {
      S.session = null; S.user = null; S.team = null; S.role = ''; S.isAdmin = false;
      S.sessionMissing = true;
      S.teams = []; S.reagents = []; S.batches = []; S.txns = []; S.roster = [];
      S.members = []; S.requests = []; S.myReq = null; S.pendingJoin = null; S.settings = {};
      try { localStorage.removeItem(LS_TEAM); } catch (e) { }
      emit();
    });
  }

  /* 换人使用：登出云端并清掉本机账号，下次必须重新用手机号验证 */
  function switchAccount() {
    return signOut().then(function () { clearAccount(); setSkip(false); });
  }

  /* 真正的「退出登录」：结束云端会话 + 清除本机账号与缓存，回到最初的手机号登录页。
     与 lockScreen() 的区别：锁定只挡界面，账号还在；登出是彻底退出。 */
  function logout() {
    function cleanup() {
      S.session = null; S.user = null; S.team = null; S.role = ''; S.isAdmin = false;
      S.sessionMissing = true; S.ready = true; S.booting = false;
      S.teams = []; S.reagents = []; S.batches = []; S.txns = []; S.roster = [];
      S.members = []; S.requests = []; S.myReq = null; S.pendingJoin = null;
      S.settings = {}; S.phone = ''; S.unlocked = false; S.status = 'idle'; S.errorMsg = '';
      try { localStorage.removeItem(LS_TEAM); localStorage.removeItem(LS_UNLOCK); } catch (e) { }
      try {
        Object.keys(localStorage).forEach(function (k) {
          if (k.indexOf(LS_CACHE) === 0) localStorage.removeItem(k);
        });
      } catch (e) { }
      clearAccount();
      setSkip(false);
      emit();
    }
    /* 云端登出失败（断网等）也要把本机清干净，否则用户会卡在「看似已登录」的状态 */
    return cloud.auth.signOut().then(cleanup, cleanup).then(function () { return true; });
  }

  /* ---------- 小组 ---------- */
  function rpc(fn, args) {
    return cloud.database.rpc(fn, args || {}).then(function (res) {
      if (res.error) throw res.error;
      return res.data;
    });
  }

  function loadTeams() {
    return rpc('my_teams', {}).then(function (rows) {
      S.teams = (rows || []).map(function (r) {
        return { id: r.team_id, name: r.team_name, settings: r.team_settings || {}, role: r.member_role, code: r.team_code };
      });
      return S.teams;
    });
  }

  /* 把自己的手机号 / 昵称写回成员表，成员列表才能显示手机号 */
  function syncMyProfile() {
    if (!S.team || !S.phone) return Promise.resolve(null);
    return rpc('set_my_profile', { p_team: S.team.id, p_phone: S.phone, p_name: '' })
      .catch(function () { return null; });
  }

  function enterTeam(teamId) {
    var t = S.teams.filter(function (x) { return x.id === teamId; })[0] || S.teams[0];
    if (!t) return Promise.resolve(false);
    S.team = t;
    S.role = t.role || 'member';
    S.isAdmin = t.role === 'admin';
    S.settings = t.settings || {};
    try { localStorage.setItem(LS_TEAM, t.id); } catch (e) { }
    loadCache();
    emit();
    /* 顺带刷新「我申请过的组」，设置页的小组卡片要用 */
    myJoinList();
    return pull().then(syncMyProfile).then(function () { return t; });
  }

  /* 切换工作台：换个小组，重新拉该组的台账 / 流水 / 成员 */
  function switchTeam(teamId) {
    if (!teamId || (S.team && teamId === S.team.id)) return Promise.resolve(S.team);
    return loadTeams().then(function () { return enterTeam(teamId); });
  }

  /* 退出小组：服务端校验（唯一管理员且还有别人的话不许直接退） */
  function leaveTeam(teamId) {
    var tid = teamId || (S.team && S.team.id);
    if (!tid) return Promise.reject(new Error('尚未进入小组'));
    if (!navigator.onLine) return Promise.reject(new Error('当前离线，无法退出小组'));
    S.status = 'syncing'; emit();
    return finish(rpc('leave_team', { p_team: tid }).then(function () {
      var wasCurrent = !!(S.team && S.team.id === tid);
      return loadTeams().then(function (teams) {
        if (!wasCurrent) { S.status = 'idle'; emit(); return { left: true, switched: null }; }
        if (!teams.length) {
          /* 一个组都没有了：回到「申请加入 / 新建小组」页 */
          S.team = null; S.role = ''; S.isAdmin = false; S.settings = {};
          S.reagents = []; S.batches = []; S.txns = []; S.roster = []; S.members = [];
          S.requests = []; S.pendingJoin = null; S.myReq = null;
          try { localStorage.removeItem(LS_TEAM); } catch (e) { }
          S.status = 'idle'; emit();
          return { left: true, switched: null };
        }
        var next = teams.filter(function (x) { return x.id === tid; })[0] || teams[0];
        return enterTeam(next.id).then(function () { return { left: true, switched: next }; });
      });
    }));
  }

  /* 加入其他小组（提交申请；如果本来就是成员则直接切过去） */
  function joinTeam(code, name) {
    var c = String(code || '').trim();
    if (!c) return Promise.reject(new Error('请输入组口令'));
    if (!navigator.onLine) return Promise.reject(new Error('当前离线，无法申请加入'));
    return requestJoin(c, name).then(function (res) {
      return loadTeams().then(function (teams) {
        if (res && res.joined) return { joined: true, team: S.team, count: teams.length };
        return myJoinList().then(function () {
          return { joined: false, pending: res && res.pending, count: teams.length };
        });
      });
    });
  }

  function createTeam(code, name) {
    return rpc('create_team', { p_code: code, p_name: name }).then(function (rows) {
      if (!rows || !rows.length) throw new Error('创建失败，请重试');
      return loadTeams().then(function () { return enterTeam(rows[0].team_id); });
    });
  }

  /* 申请加入：不是直接进组，先落一条待审申请，管理员同意后才成为成员 */
  function requestJoin(code, name) {
    return rpc('request_join', { p_code: code, p_phone: S.phone || '', p_name: name || '' }).then(function (rows) {
      var r = (rows || [])[0];
      if (!r) throw new Error('申请失败，请重试');
      if (r.r_status === 'member') {
        S.pendingJoin = null;
        return loadTeams().then(function () { return enterTeam(r.r_team); })
          .then(function (t) { return { joined: true, team: t }; });
      }
      S.pendingJoin = {
        teamId: r.r_team, teamName: r.r_team_name, code: r.r_team_code,
        reqId: r.r_req, status: 'pending', at: Date.now()
      };
      S.myReq = S.pendingJoin;
      emit();
      return { joined: false, pending: S.pendingJoin };
    });
  }

  /* 我发出过的申请（用于轮询「管理员同意了吗」） */
  function myJoinList() {
    return rpc('my_join_list', {}).then(function (rows) {
      var list = (rows || []).map(function (r) {
        return {
          reqId: r.r_req, teamId: r.r_team, teamName: r.r_team_name, code: r.r_code,
          status: r.r_status, at: r.r_at, decidedAt: r.r_decided, isMember: r.r_member
        };
      });
      S.myReq = list[0] || null;
      S.myJoins = list;
      emit();
      return list;
    }).catch(function () { return []; });
  }

  /* 轮询：申请被批准了就把小组拉进来 */
  function checkPending() {
    if (!S.pendingJoin) return Promise.resolve(false);
    return myJoinList().then(function (list) {
      var hit = list.filter(function (x) { return x.teamId === S.pendingJoin.teamId; })[0];
      if (!hit) return false;
      if (hit.status === 'pending') return false;
      if (hit.status === 'approved' || hit.isMember) {
        S.pendingJoin = null;
        return loadTeams().then(function () { return enterTeam(hit.teamId); }).then(function () { return true; });
      }
      /* 被拒绝：保留提示，让用户换口令再申请 */
      S.pendingJoin.status = hit.status;
      emit();
      return false;
    });
  }

  /* ---------- 成员管理 ---------- */
  function loadMembers() {
    if (!S.team) return Promise.resolve([]);
    return rpc('list_members', { p_team: S.team.id }).then(function (rows) {
      S.members = (rows || []).map(function (r) {
        return {
          owner: r.r_owner, name: r.r_name || '组员', role: r.r_role,
          phone: r.r_phone || '', me: !!r.r_me, at: r.r_at
        };
      });
      S.roster = S.members.map(function (m) { return { name: m.name, role: m.role, me: m.me, phone: m.phone }; });
      emit();
      return S.members;
    }).catch(function () { return S.members; });
  }

  function loadRequests() {
    if (!S.team || !S.isAdmin) { S.requests = []; return Promise.resolve([]); }
    return rpc('team_requests', { p_team: S.team.id }).then(function (rows) {
      S.requests = (rows || []).map(function (r) {
        return {
          reqId: String(r.r_req), owner: r.r_owner, phone: r.r_phone || '',
          name: r.r_name || '未命名', status: r.r_status, at: r.r_at,
          decidedAt: r.r_decided, isMember: !!r.r_member
        };
      });
      emit();
      return S.requests;
    }).catch(function () { return S.requests; });
  }

  function decideJoin(reqId, ok) {
    return rpc('decide_join', { p_req: Number(reqId), p_ok: !!ok }).then(function () {
      return Promise.all([loadMembers(), loadRequests()]);
    });
  }

  function removeMember(owner) {
    return rpc('remove_member', { p_team: S.team.id, p_owner: owner }).then(function () {
      return Promise.all([loadMembers(), loadRequests()]);
    });
  }

  function setMemberRole(owner, role) {
    return rpc('set_member_role', { p_team: S.team.id, p_owner: owner, p_role: role }).then(function () {
      return loadMembers();
    });
  }

  /* 管理员重新加载自己的角色（被降级 / 升级后立即生效） */
  function refreshMyRole() {
    return loadTeams().then(function (teams) {
      var t = teams.filter(function (x) { return S.team && x.id === S.team.id; })[0];
      if (!t) return S.role;
      S.role = t.role; S.isAdmin = t.role === 'admin'; S.team.role = t.role;
      S.settings = t.settings || {};
      S.team.settings = S.settings;
      emit();
      return S.role;
    }).catch(function () { return S.role; });
  }

  /* 只刷新小组设置（含管理员转让请求），不动其它数据 */
  function refreshTeamSettings() {
    return loadTeams().then(function (teams) {
      var t = teams.filter(function (x) { return S.team && x.id === S.team.id; })[0];
      if (t) {
        S.settings = t.settings || {};
        S.team.settings = S.settings;
        S.team.name = t.name;
      }
      emit();
      return t;
    });
  }

  /* ---------- 管理员转让 ----------
     存在 teams.settings.admin_transfer 里，双方看的是同一条记录：
       pending → 接收人接受后由服务端把两人角色对调；拒绝或撤回则作废。
     -------------------------------------------------- */
  function myOwnerId() {
    var me = (S.members || []).filter(function (m) { return m.me; })[0];
    if (me) return me.owner;
    var u = S.user || {};
    return u.id || u.owner || '';
  }

  function adminTransfer() {
    var t = (S.settings || {}).admin_transfer;
    if (!t || !t.to) return null;
    return {
      to: t.to, toName: t.to_name || '组员',
      by: t.by, byName: t.by_name || '管理员',
      at: t.at, status: t.status || 'pending', decidedAt: t.decided_at
    };
  }

  function requestAdminTransfer(to) {
    if (!S.team) return Promise.reject(new Error('尚未进入小组'));
    if (!S.isAdmin) return Promise.reject(new Error('只有小组管理员可以转让管理员'));
    if (!to || to === myOwnerId()) return Promise.reject(new Error('请选择另一位组员'));
    return rpc('request_admin_transfer', { p_team: S.team.id, p_to: to })
      .then(refreshTeamSettings).then(function () { return adminTransfer(); });
  }

  function respondAdminTransfer(accept) {
    if (!S.team) return Promise.reject(new Error('尚未进入小组'));
    if (!navigator.onLine) return Promise.reject(new Error('当前离线，无法处理转让'));
    return rpc('respond_admin_transfer', { p_team: S.team.id, p_accept: !!accept })
      .then(refreshTeamSettings)
      .then(function () { return loadMembers(); })
      .then(function () { return refreshMyRole(); })
      .then(function () { return adminTransfer(); });
  }

  function cancelAdminTransfer() {
    if (!S.team) return Promise.reject(new Error('尚未进入小组'));
    return rpc('cancel_admin_transfer', { p_team: S.team.id })
      .then(refreshTeamSettings).then(function () { return adminTransfer(); });
  }

  function saveTeamSettings(patch) {
    var next = Object.assign({}, S.settings || {}, patch || {});
    S.status = 'syncing'; emit();
    return cloud.database.from('teams').update({ settings: next }).eq('id', S.team.id).select()
      .then(function (res) {
        if (res.error) throw res.error;
        if (!res.data || !res.data.length) throw new Error('没有权限修改小组设置');
        S.settings = next;
        S.status = 'idle'; saveCache(); emit();
        return next;
      })
      .catch(function (e) { S.status = 'error'; S.errorMsg = msg(e); emit(); throw e; });
  }

  function setDisplayName(name) {
    return rpc('set_display_name', { p_team: S.team.id, p_name: name }).then(function () {
      return pull();
    });
  }

  function renameTeam(name) {
    return rpc('rename_team', { p_team: S.team.id, p_name: name }).then(function () {
      S.team.name = name;
      S.teams.forEach(function (t) { if (t.id === S.team.id) t.name = name; });
      emit();
      return name;
    });
  }

  /* ---------- 拉取 ---------- */
  var pulling = null;
  function pull() {
    if (!S.team) return Promise.resolve();
    if (pulling) return pulling;
    S.status = 'syncing'; S.errorMsg = ''; emit();
    var tid = S.team.id;
    pulling = Promise.all([
      cloud.database.from('reagents').select('*').eq('team_id', tid).limit(4000),
      cloud.database.from('batches').select('*').eq('team_id', tid).limit(4000),
      cloud.database.from('txns').select('*').eq('team_id', tid).limit(4000),
      rpc('list_members', { p_team: tid }).catch(function () { return []; })
    ]).then(function (rs) {
      var err = rs[0].error || rs[1].error || rs[2].error;
      if (err) throw err;
      S.reagents = rs[0].data || [];
      S.batches = rs[1].data || [];
      S.txns = rs[2].data || [];
      S.members = (rs[3] || []).map(function (r) {
        return {
          owner: r.r_owner, name: r.r_name || '组员', role: r.r_role,
          phone: r.r_phone || '', me: !!r.r_me, at: r.r_at
        };
      });
      S.roster = S.members.map(function (m) {
        return { name: m.name, role: m.role, me: m.me, phone: m.phone };
      });
      S.lastSync = Date.now();
      S.status = 'idle';
      saveCache(); emit();
      pulling = null;
      if (S.isAdmin) loadRequests();
    }).catch(function (e) {
      pulling = null;
      S.status = navigator.onLine ? 'error' : 'offline';
      S.errorMsg = msg(e);
      emit();
    });
    return pulling;
  }

  /* ---------- 写操作 ---------- */
  function guard() {
    if (!S.team) throw new Error('尚未进入小组');
    if (!navigator.onLine) throw new Error('当前离线，暂时无法登记。请联网后重试。');
  }

  function finish(promiseChain) {
    return promiseChain.catch(function (e) {
      S.status = 'error'; S.errorMsg = msg(e); emit(); throw e;
    }).then(function (r) { S.status = 'idle'; emit(); return r; });
  }

  /* 试剂主档：新增或修改 */
  function saveReagent(d) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    var row = {
      id: d.id || uid('rg'),
      team_id: S.team.id,
      name: (d.name || '').trim(),
      cas: d.cas || '',
      spec: d.spec || '',
      category: d.category || '',
      unit: d.unit || '瓶',
      location: d.location || '',
      min_stock: n(d.min_stock),
      safety: d.safety || '',
      note: d.note || '',
      deleted: false,
      updated_at: new Date().toISOString()
    };
    if (!row.name) return Promise.reject(new Error('请填写试剂名称'));
    S.status = 'syncing'; emit();
    return finish(cloud.database.from('reagents').upsert(row).select().then(function (res) {
      if (res.error) throw res.error;
      var saved = (res.data || [])[0] || row;
      var i = S.reagents.findIndex(function (x) { return x.id === saved.id; });
      if (i >= 0) S.reagents[i] = saved; else S.reagents.push(saved);
      saveCache();
      return saved;
    }));
  }

  /* 删除试剂（软删除，连同其批次） */
  function removeReagent(id) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    S.status = 'syncing'; emit();
    var now = new Date().toISOString();
    var linked = S.batches.filter(function (b) { return b.reagent_id === id && !b.deleted; });
    return finish(cloud.database.from('reagents').update({ deleted: true, updated_at: now }).eq('id', id).select()
      .then(function (res) {
        if (res.error) throw res.error;
        var r = S.reagents.find(function (x) { return x.id === id; });
        if (r) { r.deleted = true; r.updated_at = now; }
        if (!linked.length) { saveCache(); return; }
        return cloud.database.from('batches').update({ deleted: true, updated_at: now })
          .in('id', linked.map(function (b) { return b.id; })).select()
          .then(function (r2) {
            if (r2.error) throw r2.error;
            S.batches.forEach(function (b) { if (linked.some(function (x) { return x.id === b.id; })) { b.deleted = true; b.updated_at = now; } });
            saveCache();
          });
      }));
  }

  /* 入库：建批次 + 记流水 */
  function addInbound(d) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    var qty = n(d.qty);
    if (qty <= 0) return Promise.reject(new Error('入库数量必须大于 0'));
    var batchId = uid('bt');
    var txnId = uid('tx');
    var now = new Date().toISOString();
    var batch = {
      id: batchId, team_id: S.team.id, reagent_id: d.reagentId,
      lot_no: d.lot_no || '', qty_in: qty, qty_left: qty, unit: d.unit || '瓶',
      price: d.price === '' || d.price == null ? null : n(d.price),
      supplier: d.supplier || '', arrive_date: d.arrive_date || todayStr(),
      expire_date: d.expire_date || null, location: d.location || '',
      operator_name: d.operator_name || '', note: d.note || '', deleted: false, updated_at: now
    };
    var rg = S.reagents.find(function (x) { return x.id === d.reagentId; });
    var txn = {
      id: txnId, team_id: S.team.id, kind: 'in', reagent_id: d.reagentId, batch_id: batchId,
      reagent_name: rg ? rg.name : (d.reagentName || ''), lot_no: batch.lot_no, qty: qty,
      unit: batch.unit, operator_name: batch.operator_name, purpose: '采购入库',
      project: d.project || '', txn_date: d.arrive_date || todayStr(), note: d.note || '',
      deleted: false, updated_at: now
    };
    S.status = 'syncing'; emit();
    return finish(cloud.database.from('batches').insert(batch).select().then(function (res) {
      if (res.error) throw res.error;
      S.batches.push((res.data || [])[0] || batch);
      return cloud.database.from('txns').insert(txn).select();
    }).then(function (res) {
      if (res.error) throw res.error;
      S.txns.push((res.data || [])[0] || txn);
      saveCache();
      return batch;
    }));
  }

  /* 出库：扣批次 + 记流水（可一次扣多个批次） */
  function addOutbound(d) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    var items = (d.items || []).filter(function (x) { return n(x.qty) > 0; });
    if (!items.length) return Promise.reject(new Error('请填写领用数量'));
    var now = new Date().toISOString();
    var rg = S.reagents.find(function (x) { return x.id === d.reagentId; });
    S.status = 'syncing'; emit();

    var chain = Promise.resolve();
    var savedTxns = [];
    var savedBatches = [];

    items.forEach(function (it) {
      chain = chain.then(function () {
        var b = S.batches.find(function (x) { return x.id === it.batchId; });
        if (!b) throw new Error('批次不存在，请刷新后重试');
        var left = round(n(b.qty_left));
        var take = round(n(it.qty));
        if (take > left + 1e-9) throw new Error('领用量超过该批次剩余（剩余 ' + left + ' ' + (b.unit || '') + '）');
        var next = round(left - take);
        return cloud.database.from('batches').update({ qty_left: next, updated_at: now }).eq('id', b.id).select()
          .then(function (res) {
            if (res.error) throw res.error;
            if (!res.data || !res.data.length) throw new Error('没有权限修改库存');
            b.qty_left = next; b.updated_at = now;
            savedBatches.push(b);
            var txn = {
              id: uid('tx'), team_id: S.team.id, kind: 'out', reagent_id: d.reagentId, batch_id: b.id,
              reagent_name: rg ? rg.name : (d.reagentName || ''), lot_no: b.lot_no || '',
              qty: take, unit: b.unit || '', operator_name: d.operator_name || '',
              purpose: d.purpose || '', project: d.project || '',
              txn_date: d.txn_date || todayStr(), note: d.note || '',
              deleted: false, updated_at: now
            };
            return cloud.database.from('txns').insert(txn).select().then(function (r2) {
              if (r2.error) throw r2.error;
              var row = (r2.data || [])[0] || txn;
              S.txns.push(row); savedTxns.push(row);
            });
          });
      });
    });

    return finish(chain.then(function () { saveCache(); return savedTxns; }));
  }

  /* 盘点调整：把批次剩余量改成实盘数，记一条 adjust 流水 */
  function adjustBatch(d) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    var b = S.batches.find(function (x) { return x.id === d.batchId; });
    if (!b) return Promise.reject(new Error('批次不存在'));
    var before = round(n(b.qty_left));
    var after = round(n(d.qty));
    if (after < 0) return Promise.reject(new Error('实盘数不能为负'));
    var diff = round(after - before);
    if (diff === 0) return Promise.reject(new Error('实盘数与账面一致，无需调整'));
    var now = new Date().toISOString();
    var rg = S.reagents.find(function (x) { return x.id === b.reagent_id; });
    S.status = 'syncing'; emit();
    return finish(cloud.database.from('batches').update({ qty_left: after, updated_at: now }).eq('id', b.id).select()
      .then(function (res) {
        if (res.error) throw res.error;
        if (!res.data || !res.data.length) throw new Error('没有权限修改库存');
        b.qty_left = after; b.updated_at = now;
        var txn = {
          id: uid('tx'), team_id: S.team.id, kind: 'adjust', reagent_id: b.reagent_id, batch_id: b.id,
          reagent_name: rg ? rg.name : '', lot_no: b.lot_no || '', qty: diff, unit: b.unit || '',
          operator_name: d.operator_name || '', purpose: '盘点调整',
          project: '', txn_date: todayStr(),
          note: (diff > 0 ? '盘盈 ' : '盘亏 ') + Math.abs(diff) + '（账面 ' + before + ' → 实盘 ' + after + '）' + (d.note ? '；' + d.note : ''),
          deleted: false, updated_at: now
        };
        return cloud.database.from('txns').insert(txn).select().then(function (r2) {
          if (r2.error) throw r2.error;
          S.txns.push((r2.data || [])[0] || txn);
          saveCache();
          return txn;
        });
      }));
  }

  /* 撤销出库：把量还给批次，流水标记删除 */
  function undoOut(txnId) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    var t = S.txns.find(function (x) { return x.id === txnId; });
    if (!t) return Promise.reject(new Error('流水不存在'));
    if (t.kind !== 'out') return Promise.reject(new Error('只有出库流水可以撤销'));
    if (t.deleted) return Promise.reject(new Error('该流水已撤销'));
    var b = S.batches.find(function (x) { return x.id === t.batch_id; });
    if (!b) return Promise.reject(new Error('对应批次已不存在，无法撤销'));
    var now = new Date().toISOString();
    var next = round(n(b.qty_left) + n(t.qty));
    S.status = 'syncing'; emit();
    return finish(cloud.database.from('batches').update({ qty_left: next, updated_at: now }).eq('id', b.id).select()
      .then(function (res) {
        if (res.error) throw res.error;
        b.qty_left = next;
        return cloud.database.from('txns').update({ deleted: true, updated_at: now }).eq('id', txnId).select();
      }).then(function (res) {
        if (res.error) throw res.error;
        t.deleted = true; t.updated_at = now;
        saveCache();
        return true;
      }));
  }

  /* 作废批次（仅未使用过的批次） */
  function voidBatch(batchId) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    var b = S.batches.find(function (x) { return x.id === batchId; });
    if (!b) return Promise.reject(new Error('批次不存在'));
    if (round(n(b.qty_left)) !== round(n(b.qty_in))) return Promise.reject(new Error('该批次已被领用，不能直接作废，请走盘点调整'));
    var now = new Date().toISOString();
    S.status = 'syncing'; emit();
    return finish(cloud.database.from('batches').update({ deleted: true, updated_at: now }).eq('id', batchId).select()
      .then(function (res) {
        if (res.error) throw res.error;
        b.deleted = true;
        var t = S.txns.filter(function (x) { return x.batch_id === batchId && x.kind === 'in' && !x.deleted; });
        if (!t.length) { saveCache(); return; }
        return cloud.database.from('txns').update({ deleted: true, updated_at: now }).eq('id', t[0].id).select()
          .then(function (r2) {
            if (r2.error) throw r2.error;
            t[0].deleted = true;
            saveCache();
          });
      }));
  }

  /* ---------- 管理员删除流水 ----------
     服务端函数会校验调用者是不是管理员，并按类型把库存改回去：
       出库 → 数量退回批次；入库 → 该批次一并作废（仅限未被领用）；
       盘点调整 → 库存回退到调整前。
     删完重新拉一次，保证账面和流水一致。
     -------------------------------------------------- */
  function deleteTxn(txnId, reason) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    if (!S.isAdmin) return Promise.reject(new Error('只有小组管理员可以删除流水'));
    var t = S.txns.find(function (x) { return x.id === txnId; });
    if (!t) return Promise.reject(new Error('流水不存在'));
    if (t.deleted) return Promise.reject(new Error('该流水已作废'));
    S.status = 'syncing'; emit();
    return finish(rpc('admin_delete_txn', {
      p_team: S.team.id, p_txn: txnId, p_reason: reason || ''
    }).then(function () {
      return pull();
    }).then(function () { return true; }));
  }

  /* ---------- 批量设置低库存预警线 ---------- */
  function setMinStocks(list) {
    try { guard(); } catch (e) { return Promise.reject(e); }
    var items = (list || []).filter(function (x) { return x && x.id; });
    if (!items.length) return Promise.resolve(0);
    var now = new Date().toISOString();
    S.status = 'syncing'; emit();
    var chain = Promise.resolve(), done = 0;
    items.forEach(function (it) {
      chain = chain.then(function () {
        var v = n(it.min_stock);
        return cloud.database.from('reagents')
          .update({ min_stock: v, updated_at: now }).eq('id', it.id).select()
          .then(function (res) {
            if (res.error) throw res.error;
            var row = (res.data || [])[0];
            var i = S.reagents.findIndex(function (x) { return x.id === it.id; });
            if (i >= 0) {
              if (row) S.reagents[i] = Object.assign({}, S.reagents[i], row);
              else S.reagents[i].min_stock = v;
            }
            done++;
          });
      });
    });
    return finish(chain.then(function () { saveCache(); return done; }));
  }

  /* ---------- 网络状态 ---------- */
  window.addEventListener('online', function () { if (S.team) pull(); else emit(); });  window.addEventListener('offline', function () { S.status = 'offline'; emit(); });

  /* ---------- 启动 ----------
     曾经的 bug：有小组的分支直接 return enterTeam()，S.ready 永远不会置 true，
     界面就卡在「正在连接云端…」。现在无论走哪条分支都会收尾，并加超时兜底。
     ------------------------------------------------------ */
  var bootTimer = null;
  function finishBoot() {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    S.booting = false;
    S.ready = true;
    emit();
  }
  function boot() {
    if (bootTimer) { clearTimeout(bootTimer); }
    bootTimer = setTimeout(function () {
      bootTimer = null;
      if (!S.ready) {
        S.status = 'error';
        S.errorMsg = '连接云端超时，请检查网络后重试';
        finishBoot();
      }
    }, 15000);

    S.ready = false;
    S.account = readAccount();
    if (S.account && S.account.phone) S.phone = S.account.phone;
    if (!S.phone) S.phone = readLastPhone();
    emit();
    return getSession().then(function (sess) {
      if (!sess) { S.sessionMissing = true; finishBoot(); return; }
      S.sessionMissing = false;
      S.unlocked = S.unlocked || isUnlocked();
      return loadTeams().then(function (teams) {
        var saved = null;
        try { saved = localStorage.getItem(LS_TEAM); } catch (e) { }
        var target = teams.filter(function (t) { return t.id === saved; })[0] || teams[0];
        if (target) {
          return enterTeam(target.id).then(finishBoot, finishBoot);
        }
        /* 还没进组：看看有没有正在等待审批的申请 */
        return myJoinList().then(function (list) {
          var p = list.filter(function (x) { return x.status === 'pending'; })[0];
          if (p) {
            S.pendingJoin = {
              teamId: p.teamId, teamName: p.teamName, code: p.code,
              reqId: p.reqId, status: 'pending', at: p.at
            };
          }
          finishBoot();
        }, finishBoot);
      });
    }).catch(function (e) {
      S.errorMsg = msg(e);
      finishBoot();
    });
  }

  /* ---------- 对外 ---------- */
  window.Store = {
    state: S,
    on: on,
    emit: emit,
    boot: boot,
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    signInPassword: signInPassword,
    cloudPwdStart: cloudPwdStart,
    cloudPwdConfirm: cloudPwdConfirm,
    trySyncCloudPwd: trySyncCloudPwd,
    getSession: getSession,
    signOut: signOut,
    switchAccount: switchAccount,
    logout: logout,
    saveAccount: saveAccount,
    checkPassword: checkPassword,
    markCloudPwd: markCloudPwd,
    readAccount: readAccount,
    readLastPhone: readLastPhone,
    saveLastPhone: saveLastPhone,
    clearAccount: clearAccount,
    skipSetup: skipSetup,
    setSkip: setSkip,
    unlock: unlock,
    isUnlocked: isUnlocked,
    lockScreen: lockScreen,
    normPhone: normPhone,
    maskPhone: maskPhone,
    loadTeams: loadTeams,
    enterTeam: enterTeam,
    switchTeam: switchTeam,
    leaveTeam: leaveTeam,
    joinTeam: joinTeam,
    createTeam: createTeam,
    requestJoin: requestJoin,
    myJoinList: myJoinList,
    checkPending: checkPending,
    loadMembers: loadMembers,
    loadRequests: loadRequests,
    decideJoin: decideJoin,
    removeMember: removeMember,
    setMemberRole: setMemberRole,
    refreshMyRole: refreshMyRole,
    refreshTeamSettings: refreshTeamSettings,
    myOwnerId: myOwnerId,
    adminTransfer: adminTransfer,
    requestAdminTransfer: requestAdminTransfer,
    respondAdminTransfer: respondAdminTransfer,
    cancelAdminTransfer: cancelAdminTransfer,
    syncMyProfile: syncMyProfile,
    saveTeamSettings: saveTeamSettings,
    setDisplayName: setDisplayName,
    renameTeam: renameTeam,
    pull: pull,
    saveReagent: saveReagent,
    removeReagent: removeReagent,
    addInbound: addInbound,
    addOutbound: addOutbound,
    adjustBatch: adjustBatch,
    undoOut: undoOut,
    voidBatch: voidBatch,
    deleteTxn: deleteTxn,
    setMinStocks: setMinStocks,
    settings: settings,
    defaults: DEFAULTS,
    util: { n: n, round: round, todayStr: todayStr, lotToday: lotToday, uid: uid, msg: msg }
  };
})();
