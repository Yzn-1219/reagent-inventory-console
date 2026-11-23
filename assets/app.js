/* ============================================================
   试剂出入库管理台 · 界面层
   ============================================================ */
(function () {
  'use strict';

  var S = Store.state;
  var U = Store.util;

  /* 版本号：构建标识写在 index.html 里（随页面一起更新），这里只做兜底 */
  var APP_VER = '2.2';
  var APP_BUILD = window.APP_BUILD || 'dev';

  var UI = {
    view: 'overview',
    q: '', cat: '', st: '',
    expanded: {},
    txnKind: 'all', txnFrom: '', txnTo: '', txnQ: '',
    draftIn: null,
    draftOut: null,
    adjust: {},
    authMode: '',        // '' | 'otp' | 'reset'
    otpInfo: null,       // { phone, verificationId, isExistingUser, sent }
    resetInfo: null,     // { phone, vid }
    rememberMe: true,
    bootTimer: null,
    teamMode: 'join',
    qrCode: '',
    qrPhone: '',
    pollTimer: null,
    busy: false,
    pendingRender: false
  };

  /* ---------------- 基础工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v, d) {
    var x = Number(v);
    if (!isFinite(x)) return d == null ? '—' : d;
    return (Math.round(x * 100) / 100).toString();
  }
  function money(v) {
    if (v == null || v === '') return '—';
    return '¥' + (Math.round(Number(v) * 100) / 100).toFixed(2);
  }
  function today() { return U.todayStr(); }
  function fmtDate(d) { return d ? String(d).slice(0, 10) : '—'; }
  function shortDate(d) {
    if (!d) return '—';
    var s = String(d).slice(0, 10);
    return s.slice(5);
  }
  function myName() {
    var me = (S.roster || []).filter(function (r) { return r.me; })[0];
    return me ? me.name : '';
  }
  function myOwnerId() {
    var me = (S.members || []).filter(function (m) { return m.me; })[0];
    if (me) return me.owner;
    if (Store.myOwnerId) { try { return Store.myOwnerId(); } catch (e) { } }
    return '';
  }

  /* ---------------- 派生数据 ---------------- */
  function liveReagents() { return (S.reagents || []).filter(function (r) { return !r.deleted; }); }
  function liveBatches(rid) {
    return (S.batches || []).filter(function (b) {
      return !b.deleted && (rid ? b.reagent_id === rid : true);
    });
  }
  function liveTxns() { return (S.txns || []).filter(function (t) { return !t.deleted; }); }

  /* 批次按到货日期先进先出（不再看效期） */
  function batchesOf(rid) {
    return liveBatches(rid).slice().sort(function (a, b) {
      var ea = a.arrive_date || '', eb = b.arrive_date || '';
      if (ea !== eb) return ea < eb ? -1 : 1;
      return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
    });
  }
  function stockOf(rid) {
    return liveBatches(rid).reduce(function (s, b) { return s + U.n(b.qty_left); }, 0);
  }
  function reagentStatus(r) {
    var total = stockOf(r.id);
    if (total <= 0) return { code: 'zero', label: '零库存', cls: 'pill-mute' };
    if (total <= U.n(r.min_stock)) return { code: 'low', label: '低库存', cls: 'pill-warn' };
    return { code: 'ok', label: '正常', cls: 'pill-ok' };
  }

  function stats() {
    var rs = liveReagents();
    var bs = liveBatches().filter(function (b) { return U.n(b.qty_left) > 0; });
    var low = 0, zero = 0, totalQty = 0, value = 0;
    bs.forEach(function (b) {
      totalQty += U.n(b.qty_left);
      if (b.price != null && b.price !== '') value += U.n(b.price) * U.n(b.qty_left);
    });
    rs.forEach(function (r) {
      var t = stockOf(r.id);
      if (t <= 0) zero++;
      else if (t <= U.n(r.min_stock)) low++;
    });
    var ym = today().slice(0, 7);
    var monthTx = liveTxns().filter(function (t) { return String(t.txn_date).slice(0, 7) === ym; }).length;
    return {
      kinds: rs.length, totalQty: totalQty, low: low, zero: zero,
      monthTx: monthTx, value: value, batches: bs.length
    };
  }

  /* ---------------- 渲染骨架 ---------------- */
  function isEditing() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName;
    return (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') && document.getElementById('root').contains(el);
  }

  function render(force) {
    if (!force) {
      if (UI.busy) { UI.pendingRender = true; return; }
      if (isEditing()) { UI.pendingRender = true; return; }
    }
    UI.pendingRender = false;
    var root = document.getElementById('root');

    if (!S.ready) { root.innerHTML = viewBoot(); armBootHelp(); return; }

    /* 1. 云端未登录 */
    if (!S.session) {
      if (UI.authMode === 'otp') { root.innerHTML = viewOtp(); return; }
      if (UI.authMode === 'reset') { root.innerHTML = viewResetPwd(); return; }
      root.innerHTML = viewPwdLogin();
      return;
    }
    /* 2. 已登录：补设密码 / 重设密码 */
    if (UI.authMode === 'reset') { root.innerHTML = viewResetPwd(); armPendingPoll(); return; }
    if (UI.authMode === 'newpwd') { root.innerHTML = viewNewPwd(); return; }
    /* 2.1 设过密码但这次没勾「记住我」→ 先解锁 */
    if (S.account && !Store.isUnlocked()) { root.innerHTML = viewPwdLogin(); return; }
    /* 3. 已登录但还没进小组：申请中 → 等待页；否则申请页 */
    if (!S.team) {
      root.innerHTML = (S.pendingJoin && S.pendingJoin.status === 'pending') ? viewPending() : viewTeamGate();
      armPendingPoll();
      return;
    }

    root.innerHTML = viewShell();
  }

  document.addEventListener('focusout', function () {
    if (UI.pendingRender) setTimeout(function () { if (!isEditing()) render(); }, 0);
  });

  /* ---------------- 启动中 ---------------- */
  function viewBoot() {
    return '<div class="gate"><div class="gate-card">' +
      '<div class="gate-logo">试</div>' +
      '<div class="gate-title">试剂出入库管理台</div>' +
      '<div class="gate-sub" id="boot-sub">正在连接云端…</div>' +
      '<div class="bootbar"><i></i></div>' +
      '<div id="boot-actions" style="margin-top:18px"></div>' +
      '</div></div>';
  }
  function armBootHelp() {
    if (UI.bootTimer) return;
    UI.bootTimer = setTimeout(function () {
      UI.bootTimer = null;
      var sub = document.getElementById('boot-sub');
      var acts = document.getElementById('boot-actions');
      if (!sub || !acts) return;
      sub.textContent = '连接有点慢，可以点下面重试';
      acts.innerHTML = '<button class="btn btn-sm" data-act="reboot">重新连接</button>';
    }, 6000);
  }

  /* ---------------- 登录：手机号 + 密码 ---------------- */
  function phonePrefill() {
    return S.phone || (S.account && S.account.phone) || Store.readLastPhone() || UI.qrPhone || '';
  }

  function viewPwdLogin() {
    var ph = phonePrefill();
    var hasAcct = !!S.account;
    return '' +
      '<div class="gate"><div class="gate-card">' +
      '<div class="gate-logo">试</div>' +
      '<div class="gate-title">试剂出入库管理台</div>' +
      '<div class="gate-sub">' + (hasAcct ? '欢迎回来，输入手机号和密码' : '手机号就是账号，一个手机号一个人') + '</div>' +
      '<div class="gate-form">' +
      '<form data-form="login-pwd">' +
      '<div class="field"><label>手机号</label><input data-bind="phone" type="tel" inputmode="numeric" maxlength="11" autocomplete="username" value="' + esc(ph) + '" placeholder="11 位手机号"></div>' +
      '<div class="field"><label>密码</label><input data-bind="password" type="password" autocomplete="current-password" placeholder="登录密码"></div>' +
      '<div class="err" id="login-err"></div>' +
      '<button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">登 录</button>' +
      '<label class="ck"><input type="checkbox" id="remember-me"' + (UI.rememberMe ? ' checked' : '') + '><span>记住我（30 天内免密码）</span></label>' +
      '</form>' +
      '</div>' +
      '<div class="gate-foot">' +
      '<a href="javascript:void 0" data-act="use-otp">首次使用 / 忘记密码</a>' +
      '<span class="dot">·</span>' +
      '<a href="javascript:void 0" data-act="switch-account">换个手机号</a>' +
      '</div>' +
      '<div class="gate-note">第一次用请点「首次使用」，收一条短信设好密码，以后打开只输手机号 + 密码。</div>' +
      '</div></div>';
  }

  /* ---------------- 手机号验证码（注册 / 新设备 / 忘记密码） ---------------- */
  function viewOtp() {
    var info = UI.otpInfo || {};
    var sent = !!info.sent;
    var ph = info.phone || phonePrefill();
    var needPwd = sent && !info.isExistingUser;
    var sub = !sent
      ? '输入手机号获取验证码。新手机号会让你顺手设一个登录密码，之后就不用再收短信了。'
      : (info.isExistingUser
        ? '这是已有账号，验证后即可进入。想要手机号 + 密码登录，进入后在设置里设一次密码。'
        : '新账号：设一个密码，以后换手机也能直接用手机号 + 密码登录。');
    return '' +
      '<div class="gate"><div class="gate-card">' +
      '<div class="gate-logo">短</div>' +
      '<div class="gate-title">' + (sent ? (needPwd ? '设置你的账号' : '验证手机号') : '手机号验证') + '</div>' +
      '<div class="gate-sub">' + sub + '</div>' +
      '<div class="gate-form">' +
      '<form data-form="otp">' +
      '<div class="field"><label>手机号</label>' +
      '<div class="input-group">' +
      '<input data-bind="phone" type="tel" inputmode="numeric" maxlength="11" autocomplete="tel" value="' + esc(ph) + '" placeholder="11 位手机号"' + (sent ? ' readonly' : '') + '>' +
      (sent ? '' : '<button type="button" class="btn btn-sm" data-act="send-code" style="min-width:96px">获取验证码</button>') +
      '</div></div>' +
      (sent
        ? '<div class="field"><label>验证码</label><div class="input-group">' +
        '<input data-bind="token" inputmode="numeric" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code">' +
        '<button type="button" class="btn btn-sm" data-act="send-code" style="min-width:96px">重新发送</button>' +
        '</div></div>'
        : '') +
      (needPwd
        ? '<div class="field"><label>设置登录密码</label><input data-bind="password" type="password" autocomplete="new-password" placeholder="至少 6 位"><div class="tip">新账号必须设一个，之后手机号 + 密码直接登录</div></div>' +
        '<div class="field"><label>确认密码</label><input data-bind="password2" type="password" autocomplete="new-password" placeholder="再输一次"></div>'
        : '') +
      '<div class="err" id="login-err"></div>' +
      (sent ? '<button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">' + (needPwd ? '验证并创建账号' : '验证并进入') + '</button>' : '') +
      '</form>' +
      '</div>' +
      '<div class="gate-foot"><a href="javascript:void 0" data-act="back-login">返回手机号 + 密码登录</a></div>' +
      '</div></div>';
  }

  /* ---------------- 设置 / 重置登录密码（老账号补云端密码） ---------------- */
  function viewResetPwd() {
    var r = UI.resetInfo || {};
    var ph = r.phone || phonePrefill();
    return '' +
      '<div class="gate"><div class="gate-card">' +
      '<div class="gate-logo">密</div>' +
      '<div class="gate-title">设置登录密码</div>' +
      '<div class="gate-sub">用手机号收一条验证码，就能设定（或重设）登录密码。设好之后只输手机号 + 密码，换手机也能登。</div>' +
      '<div class="gate-form">' +
      '<form data-form="reset-pwd">' +
      '<div class="field"><label>手机号</label>' +
      '<div class="input-group">' +
      '<input data-bind="phone" type="tel" inputmode="numeric" maxlength="11" value="' + esc(ph) + '" placeholder="11 位手机号">' +
      '<button type="button" class="btn btn-sm" data-act="send-reset-code" style="min-width:96px">获取验证码</button>' +
      '</div></div>' +
      '<div class="field"><label>验证码</label><input data-bind="token" inputmode="numeric" maxlength="6" placeholder="6 位数字" autocomplete="one-time-code"></div>' +
      '<div class="field"><label>新密码</label><input data-bind="password" type="password" autocomplete="new-password" placeholder="至少 6 位"></div>' +
      '<div class="field"><label>确认新密码</label><input data-bind="password2" type="password" autocomplete="new-password" placeholder="再输一次"></div>' +
      '<div class="err" id="login-err"></div>' +
      '<button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">保存密码</button>' +
      '</form>' +
      '</div>' +
      '<div class="gate-foot"><a href="javascript:void 0" data-act="back-login">返回登录</a></div>' +
      '</div></div>';
  }

  /* ---------------- 小组入口：申请加入 / 新建 ---------------- */
  function viewTeamGate() {
    var join = UI.teamMode === 'join';
    var code = UI.qrCode || '';
    return '' +
      '<div class="gate"><div class="gate-card">' +
      '<div class="gate-logo">' + (join ? '入' : '建') + '</div>' +
      '<div class="gate-title">' + (join ? '申请加入小组' : '创建小组') + '</div>' +
      '<div class="gate-sub">' + (join
        ? '输入管理员给的组口令提交申请，管理员同意后即可进入。之后再用手机号 + 密码登录，不会再问口令。'
        : '创建后你自动成为管理员，可以审批别人加入、增减成员。') + '</div>' +
      '<div class="gate-form">' +
      '<div class="seg">' +
      '<button data-act="team-mode" data-mode="join" class="' + (join ? 'on' : '') + '">加入小组</button>' +
      '<button data-act="team-mode" data-mode="create" class="' + (!join ? 'on' : '') + '">新建小组</button>' +
      '</div>' +
      '<form data-form="team">' +
      (join ? '' : '<div class="field"><label>小组名称</label><input data-bind="tname" placeholder="例如：荜茇提取课题组"></div>') +
      '<div class="field"><label>小组口令</label><input data-bind="tcode" value="' + esc(code) + '" placeholder="' + (join ? '输入组口令' : '自定义，至少 4 位') + '">' +
      '<div class="tip">' + (join ? '口令不区分大小写，可向管理员索取或扫二维码' : '建议用字母 + 数字组合，方便当面告知') + '</div></div>' +
      '<div class="err" id="team-err"></div>' +
      '<button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">' + (join ? '提交加入申请' : '创建并进入') + '</button>' +
      '</form>' +
      '</div>' +
      '<div class="gate-foot"><a href="javascript:void 0" data-act="switch-account">换个手机号（会退出当前账号）</a></div>' +
      '</div></div>';
  }

  /* ---------------- 等待管理员审批 ---------------- */
  function viewPending() {
    var p = S.pendingJoin || {};
    var rejected = p.status === 'rejected';
    return '' +
      '<div class="gate"><div class="gate-card">' +
      '<div class="gate-logo">' + (rejected ? '退' : '等') + '</div>' +
      '<div class="gate-title">' + (rejected ? '申请未通过' : '等待管理员确认') + '</div>' +
      '<div class="gate-sub">' + (rejected
        ? '管理员没有通过你加入「' + esc(p.teamName || '该小组') + '」的申请。可以确认一下组口令，或直接联系管理员。'
        : '已向「' + esc(p.teamName || '该小组') + '」提交加入申请，管理员同意后会自动进入。') + '</div>' +
      '<div class="pend-box">' +
      '<div class="pend-row"><span>申请人</span><b>' + esc(Store.maskPhone(p.phone || S.phone)) + '</b></div>' +
      '<div class="pend-row"><span>小组口令</span><b>' + esc(p.code || '—') + '</b></div>' +
      '<div class="pend-row"><span>提交时间</span><b>' + (p.at ? new Date(p.at).toLocaleString('zh-CN') : '刚刚') + '</b></div>' +
      '</div>' +
      '<div class="pend-hint">' + (rejected ? '可以换口令重新提交' : '页面会自动检测审批结果，也可以点下面手动刷新') + '</div>' +
      (rejected ? '' : '<button class="btn btn-primary btn-block" data-act="check-pending">刷新状态</button>') +
      '<div class="gate-foot" style="margin-top:14px">' +
      '<a href="javascript:void 0" data-act="cancel-pending">' + (rejected ? '重新申请' : '换个口令重新申请') + '</a>' +
      '<span class="dot">·</span>' +
      '<a href="javascript:void 0" data-act="switch-account">换个手机号</a>' +
      '</div>' +
      '</div></div>';
  }

  /* ---------------- 设一个登录密码（已登录，本地立即可用，无需短信） ---------------- */
  function viewNewPwd() {
    return '' +
      '<div class="gate"><div class="gate-card">' +
      '<div class="gate-logo">密</div>' +
      '<div class="gate-title">设一个登录密码</div>' +
      '<div class="gate-sub">账号 ' + esc(Store.maskPhone(S.phone || '')) + ' 已登录。设个密码，以后打开只输手机号 + 密码，不用再收短信。</div>' +
      '<div class="gate-form">' +
      '<form data-form="new-pwd">' +
      '<div class="field"><label>新密码</label><input data-bind="password" type="password" autocomplete="new-password" placeholder="至少 6 位"></div>' +
      '<div class="field"><label>确认密码</label><input data-bind="password2" type="password" autocomplete="new-password" placeholder="再输一次"></div>' +
      '<div class="err" id="login-err"></div>' +
      '<button class="btn btn-primary btn-block" type="submit" style="margin-top:8px">保存并进入</button>' +
      '</form>' +
      '</div>' +
      '<div class="gate-foot"><a href="javascript:void 0" data-act="skip-newpwd">以后再说，先进入</a></div>' +
      '</div></div>';
  }

  /* 等待审批：每 5 秒问一次云端，通过了自动进组 */
  function armPendingPoll() {
    if (UI.pollTimer) { clearInterval(UI.pollTimer); UI.pollTimer = null; }
    if (!S.session || !S.pendingJoin || S.pendingJoin.status !== 'pending') return;
    UI.pollTimer = setInterval(function () {
      if (!S.pendingJoin || S.pendingJoin.status !== 'pending') {
        clearInterval(UI.pollTimer); UI.pollTimer = null; return;
      }
      Store.checkPending().then(function (ok) {
        if (ok) {
          clearInterval(UI.pollTimer); UI.pollTimer = null;
          toast('管理员已通过，欢迎加入' + (S.team ? ' ' + S.team.name : ''), 'ok');
          render(true);
        }
      });
    }, 5000);
  }

  /* ---------------- 主框架 ---------------- */
  var NAVS = [
    { k: 'overview', ic: '◉', label: '概览' },
    { k: 'inventory', ic: '▤', label: '试剂台账' },
    { k: 'inbound', ic: '↓', label: '入库登记' },
    { k: 'outbound', ic: '↑', label: '领用出库' },
    { k: 'records', ic: '≡', label: '出入库流水' },
    { k: 'stocktake', ic: '✓', label: '盘点' },
    { k: 'settings', ic: '⚙', label: '设置' }
  ];
  var TABS = [
    { k: 'overview', ic: '◉', label: '概览' },
    { k: 'inventory', ic: '▤', label: '台账' },
    { k: 'inbound', ic: '↓', label: '入库' },
    { k: 'outbound', ic: '↑', label: '出库' },
    { k: 'records', ic: '≡', label: '流水' },
    { k: 'settings', ic: '⚙', label: '我的' }
  ];

  function syncChip() {
    var cls = S.status === 'syncing' ? 'busy' : (S.status === 'idle' ? '' : 'off');
    var txt = S.status === 'syncing' ? '同步中…'
      : S.status === 'offline' ? '离线（只读）'
        : S.status === 'error' ? '同步失败'
          : (S.lastSync ? '已同步 ' + new Date(S.lastSync).toTimeString().slice(0, 5) : '已连接');
    return '<span class="sync-dot ' + cls + '" data-act="refresh" title="点击刷新"><i></i>' + txt + '</span>';
  }

  function viewShell() {
    var cur = NAVS.filter(function (x) { return x.k === UI.view; })[0] || NAVS[0];
    var st = stats();
    var badges = { overview: (st.low + st.zero) || '', inventory: liveReagents().length };
    var phoneTxt = Store.maskPhone(S.phone || (S.account && S.account.phone) || '');
    var side = '' +
      '<aside class="sidebar">' +
      '<div class="brand"><div class="logo">试</div><div><div class="name">试剂出入库</div><div class="sub">科研小组管理台</div></div></div>' +
      '<nav class="nav">' +
      NAVS.map(function (nv) {
        var b = badges[nv.k];
        return '<div class="nav-item ' + (UI.view === nv.k ? 'on' : '') + '" data-act="go" data-view="' + nv.k + '">' +
          '<span class="ic">' + nv.ic + '</span><span class="label">' + nv.label + '</span>' +
          (b ? '<span class="badge">' + b + '</span>' : '') + '</div>';
      }).join('') +
      '</nav>' +
      '<div class="side-foot">' +
      '<div class="team-chip" data-act="switch-team" title="切换或加入其他小组">' +
      '<div class="ava">' + esc((S.team.name || '组').slice(0, 1)) + '</div>' +
      '<div><div class="tname">' + esc(S.team.name) + '</div><div class="trole">' + (S.isAdmin ? '管理员' : '组员') + (myName() ? ' · ' + esc(myName()) : '') + (phoneTxt ? ' · ' + esc(phoneTxt) : '') + '</div></div>' +
      '<span class="chip-caret">⌄</span></div>' +
      '<div class="side-actions">' +
      '<button class="side-btn" data-act="lock">锁定</button>' +
      '<button class="side-btn danger" data-act="logout">退出登录</button>' +
      '</div>' +
      '</div></aside>';

    var body = '';
    if (UI.view === 'overview') body = viewOverview();
    else if (UI.view === 'inventory') body = viewInventory();
    else if (UI.view === 'inbound') body = viewInbound();
    else if (UI.view === 'outbound') body = viewOutbound();
    else if (UI.view === 'records') body = viewRecords();
    else if (UI.view === 'stocktake') body = viewStocktake();
    else body = viewSettings();

    var desc = {
      overview: '库存健康度与近期动态',
      inventory: '按试剂查看总量与批次',
      inbound: '采购到货登记，生成批次',
      outbound: '按批次先进先出领用',
      records: '全部出入库明细，可撤销与导出',
      stocktake: '实盘核对，自动生成盘盈盘亏',
      settings: '小组、单位、账号与数据导出'
    }[UI.view];

    return '' +
      '<div class="shell">' + side +
      '<div class="main">' +
      '<div class="topbar"><div><h1>' + cur.label + '</h1><div class="desc">' + desc + '</div></div>' +
      '<div class="spacer"></div>' + syncChip() +
      '<button class="btn btn-sm btn-primary hide-sm" data-act="export-xlsx">导出台账</button>' +
      '<button class="btn btn-sm hide-sm" data-act="refresh">刷新</button></div>' +
      '<div class="view">' + transferBanner() + body + '</div>' +
      '</div></div>' +
      '<div class="tabbar">' +
      TABS.map(function (tb) {
        var on = UI.view === tb.k || (tb.k === 'inventory' && UI.view === 'stocktake');
        return '<button class="' + (on ? 'on' : '') + '" data-act="go" data-view="' + tb.k + '"><span class="ic">' + tb.ic + '</span>' + tb.label + '</button>';
      }).join('') +
      '</div>';
  }

  function errBanner() {
    if (S.status === 'error' && S.errorMsg) {
      return '<div class="banner banner-danger">⚠ ' + esc(S.errorMsg) + '　<a href="javascript:void 0" data-act="refresh">重试</a></div>';
    }
    if (S.status === 'offline') {
      return '<div class="banner banner-warn">⚠ 当前处于离线状态，可查看缓存数据，登记需联网后操作。</div>';
    }
    return '';
  }

  /* 管理员转让提示：接收人看到「接受 / 拒绝」，发起人看到「等待中 / 撤回」 */
  function transferBanner() {
    var t = Store.adminTransfer ? Store.adminTransfer() : null;
    if (!t || t.status !== 'pending') return '';
    var mine = myOwnerId();
    if (t.to === mine) {
      return '<div class="banner banner-warn transfer-banner">' +
        '<div class="tb-txt"><b>' + esc(t.byName) + '</b> 想把「' + esc(S.team ? S.team.name : '') + '」的管理员转给你。' +
        '接受后你成为管理员，对方变为组员。<span class="tb-time">发起于 ' + esc(t.at ? new Date(t.at).toLocaleString('zh-CN') : '刚刚') + '</span></div>' +
        '<div class="spacer"></div>' +
        '<div class="tb-ops">' +
        '<button class="btn btn-sm btn-primary" data-act="accept-transfer">接受</button>' +
        '<button class="btn btn-sm" data-act="reject-transfer">拒绝</button>' +
        '</div></div>';
    }
    if (t.by === mine) {
      return '<div class="banner banner-info transfer-banner">' +
        '<div class="tb-txt">已向 <b>' + esc(t.toName) + '</b> 发出管理员转让，对方接受后才生效。</div>' +
        '<div class="spacer"></div>' +
        '<div class="tb-ops"><button class="btn btn-sm" data-act="cancel-transfer">撤回</button></div></div>';
    }
    return '';
  }

  /* ---------------- 概览 ---------------- */
  function viewOverview() {
    var st = stats();

    var recentIn = liveBatches().slice().sort(function (a, b) {
      return String(b.arrive_date || '') < String(a.arrive_date || '') ? -1 : 1;
    }).slice(0, 10);

    var lowList = liveReagents().filter(function (r) {
      var t = stockOf(r.id);
      return t <= U.n(r.min_stock);
    }).slice(0, 10);

    var recent = liveTxns().slice().sort(function (a, b) {
      return (b.created_at || '') < (a.created_at || '') ? -1 : 1;
    }).slice(0, 8);

    return errBanner() +
      '<div class="stat-grid">' +
      stat('试剂品种', st.kinds, '种') +
      stat('在库总量', num(st.totalQty), '件') +
      stat('低库存试剂', st.low, '种', st.low ? 's-warn' : '') +
      stat('零库存', st.zero, '种', st.zero ? 's-danger' : '') +
      stat('库存价值', st.value ? '¥' + Math.round(st.value) : '—', '', '') +
      stat('本月流水', st.monthTx, '笔') +
      '</div>' +
      '<div class="cols">' +
      '<div class="card"><div class="card-head"><h2>最近入库</h2><span class="sub">最新 ' + recentIn.length + ' 个批次</span><div class="spacer"></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="go" data-view="inbound">去入库</button></div>' +
      '<div class="card-body tight">' +
      (recentIn.length ? '<div class="item-list">' + recentIn.map(function (b) {
        var r = S.reagents.filter(function (y) { return y.id === b.reagent_id; })[0];
        return '<div class="item-row"><div class="main-info"><div class="t">' + esc(r ? r.name : '（已删除）') +
          ' <span class="muted" style="font-weight:400">批号 ' + esc(b.lot_no || '—') + '</span></div>' +
          '<div class="s">' + fmtDate(b.arrive_date) + ' 入库' + (b.supplier ? ' · ' + esc(b.supplier) : '') + (b.location ? ' · ' + esc(b.location) : '') + '</div></div>' +
          '<span class="pill pill-in">+' + num(b.qty_in) + ' ' + esc(b.unit || '') + '</span></div>';
      }).join('') + '</div>' : emptyBlock('还没有入库记录', '去「入库登记」添加第一批试剂')) +
      '</div></div>' +
      '<div class="card"><div class="card-head"><h2>低库存</h2><span class="sub">已低于预警线</span><div class="spacer"></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="min-stock">设置预警线</button></div>' +
      '<div class="card-body tight">' +
      (lowList.length ? '<div class="item-list">' + lowList.map(function (r) {
        var t = stockOf(r.id);
        return '<div class="item-row"><div class="main-info"><div class="t">' + esc(r.name) + '</div>' +
          '<div class="s">' + (r.spec ? esc(r.spec) + ' · ' : '') + '预警线 ' + num(r.min_stock) + ' ' + esc(r.unit) + '</div></div>' +
          '<span class="pill ' + (t <= 0 ? 'pill-mute' : 'pill-warn') + '">' + num(t) + ' ' + esc(r.unit) + '</span></div>';
      }).join('') + '</div>' : emptyBlock('库存充足', '暂无低于预警线的试剂')) +
      '</div></div>' +
      '</div>' +
      '<div class="card"><div class="card-head"><h2>最近动态</h2><div class="spacer"></div>' +
      '<button class="btn btn-sm btn-ghost" data-act="go" data-view="records">全部流水</button></div>' +
      '<div class="card-body tight">' +
      (recent.length ? '<div class="item-list">' + recent.map(function (t) {
        return '<div class="item-row"><span class="pill pill-' + (t.kind === 'in' ? 'in' : t.kind === 'out' ? 'out' : 'adjust') + '">' +
          (t.kind === 'in' ? '入库' : t.kind === 'out' ? '出库' : '调整') + '</span>' +
          '<div class="main-info"><div class="t">' + esc(t.reagent_name) + (t.lot_no ? ' <span class="muted" style="font-weight:400">批号 ' + esc(t.lot_no) + '</span>' : '') + '</div>' +
          '<div class="s">' + fmtDate(t.txn_date) + ' · ' + (t.operator_name ? esc(t.operator_name) : '—') + (t.purpose ? ' · ' + esc(t.purpose) : '') + '</div></div>' +
          '<div style="font-weight:700;font-variant-numeric:tabular-nums">' + (t.kind === 'in' ? '+' : t.kind === 'out' ? '−' : (U.n(t.qty) >= 0 ? '+' : '')) + num(Math.abs(U.n(t.qty))) + ' ' + esc(t.unit || '') + '</div></div>';
      }).join('') + '</div>' : emptyBlock('还没有记录', '去「入库登记」添加第一批试剂吧')) +
      '</div></div>' +
      '<div class="card export-bar"><div class="card-body">' +
      '<div class="export-hero">' +
      '<div class="export-txt"><b>导出台账</b><span>生成标准 Excel：库存台账 + 出入库流水，可直接打印归档</span></div>' +
      '<button class="btn btn-primary export-btn" data-act="export-xlsx">导出 Excel</button>' +
      '</div></div></div>';
  }

  function stat(k, v, u, cls) {
    return '<div class="stat ' + (cls || '') + '"><div class="k">' + k + '</div><div class="v">' + v + '<span class="u">' + u + '</span></div></div>';
  }
  function emptyBlock(t, s) {
    return '<div class="empty"><div class="ic">◇</div><div class="t">' + t + '</div><div class="s">' + s + '</div></div>';
  }

  /* ---------------- 试剂台账 ---------------- */
  function filteredReagents() {
    var q = UI.q.trim().toLowerCase();
    return liveReagents().filter(function (r) {
      if (UI.cat && r.category !== UI.cat) return false;
      if (UI.st) {
        var stt = reagentStatus(r).code;
        if (UI.st === 'low') { if (!(stt === 'low' || stt === 'zero')) return false; }
        else if (stt !== UI.st) return false;
      }
      if (q) {
        var hay = [r.name, r.cas, r.spec, r.category, r.location, r.note].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
      return stockOf(b.id) - stockOf(a.id) || (a.name || '').localeCompare(b.name || '', 'zh');
    });
  }

  function viewInventory() {
    var cats = Store.settings().categories;
    return errBanner() +
      '<div class="toolbar">' +
      '<div class="search"><span class="ic">⌕</span><input id="q-inv" placeholder="搜索名称 / CAS / 规格 / 位置" value="' + esc(UI.q) + '"></div>' +
      '<select class="filter" id="f-cat"><option value="">全部分类</option>' +
      cats.map(function (c) { return '<option value="' + esc(c) + '"' + (UI.cat === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
      '</select>' +
      '<select class="filter" id="f-st"><option value="">全部状态</option>' +
      '<option value="low"' + (UI.st === 'low' ? ' selected' : '') + '>低库存 / 零库存</option>' +
      '<option value="ok"' + (UI.st === 'ok' ? ' selected' : '') + '>正常</option>' +
      '<option value="zero"' + (UI.st === 'zero' ? ' selected' : '') + '>零库存</option>' +
      '</select>' +
      '<button class="btn btn-primary btn-sm" data-act="new-reagent">＋ 新增试剂</button>' +
      '<button class="btn btn-sm" data-act="min-stock">预警线</button>' +
      '<button class="btn btn-sm hide-sm" data-act="export-xlsx">导出 Excel</button>' +
      '<button class="btn btn-sm" data-act="go" data-view="stocktake">盘点</button>' +
      '</div>' +
      '<div class="card"><div class="card-body tight" id="inv-zone">' + inventoryTable() + '</div></div>';
  }

  function inventoryTable() {
    var rows = filteredReagents();
    if (!rows.length) {
      return emptyBlock('没有匹配的试剂', liveReagents().length ? '换个筛选条件试试' : '点击右上角「新增试剂」建立第一条台账');
    }
    var body = rows.map(function (r) {
      var st = reagentStatus(r);
      var total = stockOf(r.id);
      var bs = batchesOf(r.id);
      var open = !!UI.expanded[r.id];
      var main = '<tr data-act="toggle" data-id="' + r.id + '" style="cursor:pointer">' +
        '<td><div class="cell-name">' + esc(r.name) + '</div>' +
        '<div class="cell-sub">' + esc(r.spec || '') +
        (r.cas ? '<span class="hide-sm"> · CAS ' + esc(r.cas) + '</span>' : '') +
        (r.category ? '<span class="hide-sm"> · ' + esc(r.category) + '</span>' : '') + '</div></td>' +
        '<td class="num"><b>' + num(total) + '</b> <span class="muted">' + esc(r.unit) + '</span></td>' +
        '<td class="hide-sm">' + bs.length + ' 批</td>' +
        '<td class="hide-sm muted">' + esc(r.location || '—') + '</td>' +
        '<td><span class="pill ' + st.cls + '">' + st.label + '</span>' +
        '<div class="cell-sub">' + (U.n(r.min_stock) > 0 ? '预警线 ' + num(r.min_stock) : '<span class="hide-sm">未设预警线</span><span class="only-sm">未设</span>') + '</div></td>' +
        '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn btn-sm btn-ghost" data-act="quick-in" data-id="' + r.id + '">入库</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="quick-out" data-id="' + r.id + '">出库</button>' +
        '<button class="btn btn-sm btn-ghost" data-act="edit-reagent" data-id="' + r.id + '">编辑</button>' +
        '</td></tr>';
      if (!open) return main;
      var detail = bs.length ? bs.map(function (b) {
        var usable = U.n(b.qty_left) > 0;
        return '<tr class="sub-row"><td style="padding-left:28px" colspan="1">' +
          '<div class="cell-sub">批号 <b>' + esc(b.lot_no || '—') + '</b>' + (b.supplier ? ' · ' + esc(b.supplier) : '') + (b.price != null ? ' · ' + money(b.price) : '') +
          (b.arrive_date ? ' · ' + fmtDate(b.arrive_date) + ' 入库' : '') + '</div></td>' +
          '<td class="num">' + num(b.qty_left) + ' / ' + num(b.qty_in) + '</td>' +
          '<td class="hide-sm"></td>' +
          '<td class="hide-sm muted">' + esc(b.location || '—') + '</td>' +
          '<td class="hide-sm"><span class="pill ' + (usable ? 'pill-ok' : 'pill-mute') + '">' + (usable ? '有货' : '已用完') + '</span></td>' +
          '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn btn-sm btn-ghost" data-act="adjust" data-id="' + b.id + '">盘点</button>' +
          (U.n(b.qty_left) === U.n(b.qty_in) ? '<button class="btn btn-sm btn-ghost" data-act="void-batch" data-id="' + b.id + '">作废</button>' : '') +
          '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted" style="padding-left:28px">暂无批次，点「入库」添加</td></tr>';
      return main + detail;
    }).join('');
    return '<div class="tbl-wrap"><table class="tbl tbl-inv"><thead><tr>' +
      '<th>试剂</th><th class="num">在库</th><th class="hide-sm">批次</th>' +
      '<th class="hide-sm">位置</th><th>状态</th><th style="text-align:right">操作</th>' +
      '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  /* ---------------- 入库 ---------------- */
  function blankIn() {
    return {
      reagentId: '', newReagent: false, name: '', category: '', spec: '', cas: '', unit: '瓶',
      min_stock: '', location: '', lot_no: U.lotToday(), qty: '', price: '', supplier: '',
      arrive_date: today(), operator_name: myName(), note: '', project: ''
    };
  }
  function unitOptions(withList) {
    var units = Store.settings().units.slice();
    if (withList && withList !== '__new' && units.indexOf(withList) < 0) units.unshift(withList);
    return units;
  }
  function viewInbound() {
    if (!UI.draftIn) UI.draftIn = blankIn();
    var d = UI.draftIn;
    var units = unitOptions(d.unit);
    var cats = Store.settings().categories;
    var locs = Store.settings().locations;
    var rs = liveReagents().sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'zh'); });

    return errBanner() +
      '<div class="card"><div class="card-head"><h2>到货入库</h2><span class="sub">每批货建立一个批次，余量单独管理</span></div>' +
      '<div class="card-body">' +
      '<form data-form="inbound">' +
      '<datalist id="unit-list">' + units.map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>' +
      '<div class="fs"><span class="fs-t">选试剂</span><span class="fs-s">台账里没有就选「新试剂」</span></div>' +
      '<div class="field"><label>试剂</label>' +
      '<select data-bind="reagentId">' +
      '<option value="">— 选择已有试剂 —</option>' +
      rs.map(function (r) {
        return '<option value="' + r.id + '"' + (d.reagentId === r.id ? ' selected' : '') + '>' + esc(r.name) + (r.spec ? '（' + esc(r.spec) + '）' : '') + '</option>';
      }).join('') +
      '<option value="__new" ' + (d.newReagent ? 'selected' : '') + '>＋ 新试剂（不在台账里）</option>' +
      '</select></div>' +

      (d.newReagent ? '<div class="row2">' +
        '<div class="field"><label>试剂名称 *</label><input data-bind="name" value="' + esc(d.name) + '" placeholder="如：无水乙醇"></div>' +
        '<div class="field"><label>分类</label><select data-bind="category">' +
        '<option value="">未分类</option>' + cats.map(function (c) { return '<option' + (d.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
        '</select></div>' +
        '<div class="field"><label>规格</label><input data-bind="spec" value="' + esc(d.spec) + '" placeholder="如：500 mL/瓶"></div>' +
        '<div class="field"><label>CAS 号</label><input data-bind="cas" value="' + esc(d.cas) + '" placeholder="选填"></div>' +
        '<div class="field"><label>低库存预警线</label><div class="qty"><input data-bind="min_stock" type="number" step="any" value="' + esc(d.min_stock) + '" placeholder="低于此值提醒"><span class="qty-u" id="min-u">' + esc(d.unit) + '</span></div></div>' +
        '</div>' : '') +

      '<div class="fs"><span class="fs-t">这批货</span><span class="fs-s">批号默认年+月+日，可改厂家批号</span></div>' +
      '<div class="row2">' +
      '<div class="field"><label>批号</label><input data-bind="lot_no" value="' + esc(d.lot_no) + '" placeholder="' + esc(U.lotToday()) + '"></div>' +
      '<div class="field"><label>入库数量 *</label>' +
      '<div class="qty"><input data-bind="qty" type="number" step="any" inputmode="decimal" value="' + esc(d.qty) + '" placeholder="0"><span class="qty-u" id="qty-u">' + esc(d.unit) + '</span></div></div>' +
      '<div class="field"><label>单位</label>' +
      '<input data-bind="unit" list="unit-list" value="' + esc(d.unit) + '" placeholder="瓶 / mL / g，可点选"><div class="tip">可直接选，也可填自定义单位</div></div>' +
      '<div class="field"><label>单价（元）</label><input data-bind="price" type="number" step="any" value="' + esc(d.price) + '" placeholder="选填"></div>' +
      '<div class="field"><label>供应商</label><input data-bind="supplier" value="' + esc(d.supplier) + '" placeholder="选填"></div>' +
      '<div class="field"><label>到货日期</label><input data-bind="arrive_date" type="date" value="' + esc(d.arrive_date) + '"></div>' +
      '<div class="field"><label>存放位置</label><input data-bind="location" list="loc-list" value="' + esc(d.location) + '" placeholder="如 试剂柜 A">' +
      '<datalist id="loc-list">' + locs.map(function (l) { return '<option value="' + esc(l) + '">'; }).join('') + '</datalist></div>' +
      '<div class="field"><label>经办人</label><input data-bind="operator_name" value="' + esc(d.operator_name) + '" placeholder="谁办的"></div>' +
      '</div>' +
      '<div class="field"><label>备注</label><textarea data-bind="note" placeholder="选填">' + esc(d.note) + '</textarea></div>' +
      '<div class="err" id="in-err"></div>' +
      '<div style="display:flex;gap:10px;margin-top:6px">' +
      '<button type="button" class="btn" data-act="reset-in">重置</button>' +
      '<button type="submit" class="btn btn-primary" style="flex:1">确认入库</button>' +
      '</div></form></div></div>' +
      '<div class="card"><div class="card-head"><h2>最近入库</h2></div><div class="card-body tight">' +
      recentTxns('in', 6) + '</div></div>';
  }

  function recentTxns(kind, n) {
    var list = liveTxns().filter(function (t) { return t.kind === kind; })
      .sort(function (a, b) { return (b.created_at || '') < (a.created_at || '') ? -1 : 1; }).slice(0, n);
    if (!list.length) return emptyBlock('暂无记录', '');
    return '<div class="item-list">' + list.map(function (t) {
      return '<div class="item-row"><span class="pill pill-' + (kind === 'in' ? 'in' : 'out') + '">' + (kind === 'in' ? '入库' : '出库') + '</span>' +
        '<div class="main-info"><div class="t">' + esc(t.reagent_name) + (t.lot_no ? ' <span class="muted" style="font-weight:400">批号 ' + esc(t.lot_no) + '</span>' : '') + '</div>' +
        '<div class="s">' + fmtDate(t.txn_date) + ' · ' + esc(t.operator_name || '—') + (t.purpose ? ' · ' + esc(t.purpose) : '') + '</div></div>' +
        '<div style="font-weight:700">' + num(t.qty) + ' ' + esc(t.unit || '') + '</div></div>';
    }).join('') + '</div>';
  }

  /* ---------------- 出库 ---------------- */
  function blankOut() {
    return { reagentId: '', items: {}, operator_name: myName(), purpose: '', project: '', txn_date: today(), note: '' };
  }
  function viewOutbound() {
    if (!UI.draftOut) UI.draftOut = blankOut();
    var d = UI.draftOut;
    var rs = liveReagents().filter(function (r) { return stockOf(r.id) > 0; })
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'zh'); });
    var sel = S.reagents.filter(function (r) { return r.id === d.reagentId; })[0];
    var bs = sel ? batchesOf(sel.id).filter(function (b) { return U.n(b.qty_left) > 0; }) : [];

    var batchHtml = '';
    if (sel) {
      if (!bs.length) batchHtml = emptyBlock('该试剂没有可用批次', '请先入库');
      else batchHtml = '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>批号</th><th class="num">剩余</th><th class="hide-sm">位置</th><th style="width:150px">本次领用</th>' +
        '</tr></thead><tbody>' + bs.map(function (b, i) {
          return '<tr><td>' + (i === 0 ? '<span class="pill pill-info" style="margin-right:6px">先用</span>' : '') + '<b>' + esc(b.lot_no || '—') + '</b>' +
            '<div class="cell-sub">' + fmtDate(b.arrive_date) + ' 入库' + (b.supplier ? ' · ' + esc(b.supplier) : '') + '</div></td>' +
            '<td class="num">' + num(b.qty_left) + ' <span class="muted">' + esc(b.unit || '') + '</span></td>' +
            '<td class="hide-sm muted">' + esc(b.location || '—') + '</td>' +
            '<td><div class="qty"><input type="number" step="any" inputmode="decimal" ' +
            'data-bind="item" data-batch="' + b.id + '" value="' + esc(d.items[b.id] != null ? d.items[b.id] : '') + '" placeholder="0">' +
            '<span class="qty-u">' + esc(b.unit || sel.unit || '') + '</span></div></td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="btn btn-sm" data-act="fill-first">领完第一批</button>' +
        '<button type="button" class="btn btn-sm" data-act="clear-items">清空数量</button></div>';
    }

    return errBanner() +
      '<div class="card"><div class="card-head"><h2>领用登记</h2><span class="sub">默认按到货日期先进先出</span></div>' +
      '<div class="card-body">' +
      '<form data-form="outbound">' +
      '<div class="fs"><span class="fs-t">领什么</span><span class="fs-s">只列出还有库存的试剂</span></div>' +
      '<div class="field"><label>领用试剂</label><select data-bind="reagentId">' +
      '<option value="">— 选择试剂 —</option>' +
      rs.map(function (r) { return '<option value="' + r.id + '"' + (d.reagentId === r.id ? ' selected' : '') + '>' + esc(r.name) + '（余 ' + num(stockOf(r.id)) + ' ' + esc(r.unit) + '）</option>'; }).join('') +
      '</select></div>' +
      (sel ? '<div class="fs"><span class="fs-t">从哪个批次出</span><span class="fs-s">默认先用早到货的</span></div>' +
      '<div class="field"><label>选择批次与数量</label><div style="border:1px solid var(--line);border-radius:10px;overflow:hidden">' + batchHtml + '</div></div>' : '') +
      '<div class="fs"><span class="fs-t">谁领的、干什么用</span></div>' +
      '<div class="row2">' +
      '<div class="field"><label>领用人</label><input data-bind="operator_name" value="' + esc(d.operator_name) + '" placeholder="谁领的"></div>' +
      '<div class="field"><label>领用日期</label><input data-bind="txn_date" type="date" value="' + esc(d.txn_date) + '"></div>' +
      '<div class="field"><label>用途</label><input data-bind="purpose" value="' + esc(d.purpose) + '" placeholder="如 样品前处理"></div>' +
      '<div class="field"><label>关联课题</label><input data-bind="project" value="' + esc(d.project) + '" placeholder="选填"></div>' +
      '</div>' +
      '<div class="field"><label>备注</label><textarea data-bind="note" placeholder="选填">' + esc(d.note) + '</textarea></div>' +
      '<div class="err" id="out-err"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" style="margin-top:6px">确认出库</button>' +
      '</form></div></div>' +
      '<div class="card"><div class="card-head"><h2>最近出库</h2></div><div class="card-body tight">' + recentTxns('out', 6) + '</div></div>';
  }

  /* ---------------- 流水 ---------------- */
  function filteredTxns() {
    var q = UI.txnQ.trim().toLowerCase();
    return liveTxns().filter(function (t) {
      if (UI.txnKind !== 'all' && t.kind !== UI.txnKind) return false;
      if (UI.txnFrom && String(t.txn_date).slice(0, 10) < UI.txnFrom) return false;
      if (UI.txnTo && String(t.txn_date).slice(0, 10) > UI.txnTo) return false;
      if (q) {
        var hay = [t.reagent_name, t.lot_no, t.operator_name, t.purpose, t.project, t.note].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
      return String(b.txn_date || '').localeCompare(String(a.txn_date || '')) || String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }

  function viewRecords() {
    return errBanner() +
      '<div class="toolbar">' +
      '<div class="search"><span class="ic">⌕</span><input id="q-txn" placeholder="搜索试剂 / 批号 / 领用人 / 用途" value="' + esc(UI.txnQ) + '"></div>' +
      '<select class="filter" id="f-kind">' +
      '<option value="all"' + (UI.txnKind === 'all' ? ' selected' : '') + '>全部类型</option>' +
      '<option value="in"' + (UI.txnKind === 'in' ? ' selected' : '') + '>入库</option>' +
      '<option value="out"' + (UI.txnKind === 'out' ? ' selected' : '') + '>出库</option>' +
      '<option value="adjust"' + (UI.txnKind === 'adjust' ? ' selected' : '') + '>盘点调整</option>' +
      '</select>' +
      '<input type="date" class="filter" id="f-from" value="' + esc(UI.txnFrom) + '" title="起始日期">' +
      '<input type="date" class="filter" id="f-to" value="' + esc(UI.txnTo) + '" title="结束日期">' +
      '<button class="btn btn-sm btn-primary" data-act="export-xlsx">导出 Excel</button>' +
      '<button class="btn btn-sm" data-act="export-csv">导出 CSV</button>' +
      '<button class="btn btn-sm" data-act="print">打印</button>' +
      '</div>' +
      '<div class="card"><div class="card-body tight" id="txn-zone">' + txnTable() + '</div></div>';
  }

  function txnTable() {
    var rows = filteredTxns();
    if (!rows.length) return emptyBlock('没有符合条件的流水', '调整筛选条件试试');
    var sumIn = 0, sumOut = 0;
    rows.forEach(function (t) { if (t.kind === 'in') sumIn++; else if (t.kind === 'out') sumOut++; });
    return '<div class="tbl-wrap"><table class="tbl tbl-wide"><thead><tr>' +
      '<th class="hide-sm">日期</th><th>类型</th><th>试剂</th><th class="num">数量</th>' +
      '<th class="hide-sm">领用人</th><th class="hide-sm">用途 / 课题</th><th class="hide-sm">备注</th><th></th>' +
      '</tr></thead><tbody>' + rows.map(function (t) {
        var cls = t.kind === 'in' ? 'pill-in' : t.kind === 'out' ? 'pill-out' : 'pill-adjust';
        var label = t.kind === 'in' ? '入库' : t.kind === 'out' ? '出库' : '调整';
        return '<tr><td class="hide-sm" style="white-space:nowrap">' + fmtDate(t.txn_date) + '</td>' +
          '<td><span class="pill ' + cls + '">' + label + '</span></td>' +
          '<td><div class="cell-name">' + esc(t.reagent_name || '—') + '</div>' + (t.lot_no ? '<div class="cell-sub">批号 ' + esc(t.lot_no) + '</div>' : '') +
          '<div class="cell-sub only-sm">' + esc([fmtDate(t.txn_date), t.operator_name, t.purpose].filter(Boolean).join(' · ')) + '</div></td>' +
          '<td class="num"><b>' + (t.kind === 'in' ? '+' : t.kind === 'out' ? '−' : (U.n(t.qty) >= 0 ? '+' : '−')) + num(Math.abs(U.n(t.qty))) + '</b> <span class="muted">' + esc(t.unit || '') + '</span></td>' +
          '<td class="hide-sm">' + esc(t.operator_name || '—') + '</td>' +
          '<td class="hide-sm muted">' + esc([t.purpose, t.project].filter(Boolean).join(' / ') || '—') + '</td>' +
          '<td class="hide-sm muted">' + esc(t.note || '—') + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' +
          (t.kind === 'out' ? '<button class="btn btn-sm btn-ghost" data-act="undo" data-id="' + t.id + '">撤销</button>' : '') +
          (S.isAdmin ? '<button class="btn btn-sm btn-ghost txn-del" data-act="del-txn" data-id="' + t.id + '">删除</button>' : '') +
          '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div style="padding:11px 14px;border-top:1px solid var(--line-soft);font-size:12.5px;color:var(--muted)">共 ' + rows.length + ' 条 · 入库 ' + sumIn + ' 笔 · 出库 ' + sumOut + ' 笔</div>';
  }

  /* ---------------- 盘点 ---------------- */
  function viewStocktake() {
    var bs = liveBatches().slice().sort(function (a, b) {
      return String(a.arrive_date || '9999') < String(b.arrive_date || '9999') ? -1 : 1;
    });
    if (!bs.length) return errBanner() + '<div class="card"><div class="card-body">' + emptyBlock('还没有批次', '先去入库登记') + '</div></div>';
    var rows = bs.map(function (b) {
      var r = S.reagents.filter(function (x) { return x.id === b.reagent_id; })[0];
      var v = UI.adjust[b.id];
      var cur = U.n(b.qty_left);
      var diff = v == null || v === '' ? null : U.round(U.n(v) - cur);
      return '<tr><td><div class="cell-name">' + esc(r ? r.name : '（已删除）') + '</div>' +
        '<div class="cell-sub">批号 ' + esc(b.lot_no || '—') + ' · ' + fmtDate(b.arrive_date) + ' 入库</div></td>' +
        '<td class="num">' + num(cur) + ' <span class="muted">' + esc(b.unit || '') + '</span></td>' +
        '<td style="width:130px"><input type="number" step="any" inputmode="decimal" data-adjust="' + b.id + '" value="' + esc(v == null ? '' : v) + '" placeholder="实盘" style="width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:8px"></td>' +
        '<td class="num">' + (diff == null || diff === 0 ? '<span class="muted">—</span>' : '<b style="color:' + (diff > 0 ? 'var(--ok)' : 'var(--danger)') + '">' + (diff > 0 ? '+' : '') + num(diff) + '</b>') + '</td>' +
        '<td style="text-align:right">' + (diff ? '<button class="btn btn-sm btn-ghost" data-act="apply-adjust" data-id="' + b.id + '">提交</button>' : '') + '</td></tr>';
    }).join('');
    return errBanner() +
      '<div class="banner banner-info">填写实盘数量，点「提交」后自动生成盘盈/盘亏流水，账面立即同步给全组。</div>' +
      '<div class="card"><div class="card-head"><h2>批次盘点</h2><span class="sub">共 ' + bs.length + ' 个批次</span><div class="spacer"></div>' +
      '<button class="btn btn-sm" data-act="clear-adjust">清空填写</button></div>' +
      '<div class="card-body tight"><div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>试剂 / 批次</th><th class="num">账面</th><th>实盘</th><th class="num">差异</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div></div>';
  }

  /* ---------------- 我的小组（多组切换） ---------------- */
  function teamListHtml() {
    var list = S.teams || [];
    var pending = (S.myJoins || []).filter(function (j) {
      return j.status === 'pending' && !list.some(function (t) { return t.id === j.teamId; });
    });
    if (!list.length && !pending.length) {
      return emptyBlock('还没有加入任何小组', '在下面输入组口令申请加入，或退出登录后新建一个');
    }
    var html = list.map(function (t) {
      var cur = !!(S.team && S.team.id === t.id);
      return '<div class="team-row' + (cur ? ' current' : '') + '">' +
        '<div class="ava">' + esc((t.name || '组').slice(0, 1)) + '</div>' +
        '<div class="main-info">' +
        '<div class="t">' + esc(t.name) + (cur ? ' <span class="pill pill-ok">当前</span>' : '') + '</div>' +
        '<div class="s">' + (t.role === 'admin' ? '管理员' : '组员') + (t.code ? ' · 口令 ' + esc(t.code) : '') + '</div>' +
        '</div>' +
        '<div class="row-ops">' +
        (cur ? '' : '<button class="btn btn-xs btn-primary" data-act="do-switch-team" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">进入</button>') +
        '<button class="btn btn-xs" data-act="leave-team" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">退出</button>' +
        '</div></div>';
    }).join('');
    html += pending.map(function (j) {
      return '<div class="team-row pending">' +
        '<div class="ava">' + esc((j.teamName || '组').slice(0, 1)) + '</div>' +
        '<div class="main-info"><div class="t">' + esc(j.teamName || '待审批小组') + ' <span class="pill pill-warn">待审批</span></div>' +
        '<div class="s">管理员同意后会自动出现在这里</div></div></div>';
    }).join('');
    return '<div class="team-list">' + html + '</div>';
  }

  function joinFormHtml() {
    return '<form data-form="join-team">' +
      '<div class="input-group">' +
      '<input data-bind="tcode" placeholder="输入另一组的口令" autocomplete="off">' +
      '<button class="btn btn-sm btn-primary" type="submit">申请加入</button>' +
      '</div>' +
      '<div class="tip">提交后由该组管理员审批。通过后再回到这里点「进入」，就能切到那个小组的台账。</div>' +
      '<div class="err" id="join-err"></div>' +
      '</form>';
  }

  function openTeamSwitchModal() {
    openModal('切换小组',
      '<div class="tip" style="margin-bottom:10px">一个账号可以同时在多个小组里。点「进入」即切换工作台，台账、流水、成员都会跟着换。</div>' +
      '<div style="border:1px solid var(--line);border-radius:12px;overflow:hidden">' + teamListHtml() + '</div>' +
      '<div class="fs" style="margin-top:16px"><span class="fs-t">加入其他小组</span></div>' +
      joinFormHtml(),
      '<button class="btn" data-act="close-modal">关闭</button>');
  }

  /* ---------------- 修改小组名称（仅管理员） ---------------- */
  function openRenameModal() {
    if (!S.isAdmin) { toast('只有小组管理员可以修改小组名称', 'err'); return; }
    var cur = (S.team && S.team.name) || '';
    openModal('修改小组名称',
      '<div class="field"><label>新的小组名称</label>' +
      '<input id="rn-name" value="' + esc(cur) + '" maxlength="40" placeholder="例如：荜茇提取课题组">' +
      '<div class="tip">最多 40 个字。只改显示名称，台账、流水、成员都不受影响。</div></div>' +
      '<div class="pend-box"><div class="pend-row"><span>当前名称</span><b>' + esc(cur) + '</b></div></div>' +
      '<div class="err" id="rn-err"></div>',
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn btn-primary" data-act="do-rename-team">保存</button>');
    setTimeout(function () {
      var el = document.getElementById('rn-name');
      if (el) { el.focus(); el.select(); }
    }, 60);
  }

  /* ---------------- 设置 ---------------- */
  function viewSettings() {
    var cfg = Store.settings();
    var listVal = function (a) { return (a || []).join('\n'); };
    var acct = S.account;
    var myPhone = Store.maskPhone(S.phone || (acct && acct.phone) || '');
    var members = S.members || [];
    var pending = (S.requests || []).filter(function (r) { return r.status === 'pending'; });
    var decided = (S.requests || []).filter(function (r) { return r.status !== 'pending'; }).slice(0, 8);
    var noPwd = !acct || !acct.cloudPwd;
    var allR = liveReagents();
    var lowKinds = allR.filter(function (r) { var t = stockOf(r.id); return t > 0 && t <= U.n(r.min_stock); }).length;
    var noLine = allR.filter(function (r) { return !(U.n(r.min_stock) > 0); }).length;

    function memberRow(m) {
      var isAdm = m.role === 'admin';
      var tr = Store.adminTransfer ? Store.adminTransfer() : null;
      var waiting = !!(tr && tr.status === 'pending' && tr.to === m.owner);
      var ops = '';
      if (m.me) {
        ops = '<span class="pill pill-info">我</span>';
      } else if (S.isAdmin) {
        ops = '<div class="row-ops">' +
          (isAdm
            ? '<button class="btn btn-xs" data-act="toggle-role" data-id="' + esc(m.owner) + '" data-role="member">取消管理员</button>'
            : '<button class="btn btn-xs" data-act="transfer-admin" data-id="' + esc(m.owner) + '" data-name="' + esc(m.name) + '"' + (waiting ? ' disabled' : '') + '>' + (waiting ? '待对方确认' : '转让管理员') + '</button>') +
          '<button class="btn btn-xs btn-danger" data-act="del-member" data-id="' + esc(m.owner) + '" data-name="' + esc(m.name) + '">移除</button>' +
          '</div>';
      }
      return '<div class="item-row">' +
        '<div class="ava" style="width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">' + esc((m.name || '组').slice(0, 1)) + '</div>' +
        '<div class="main-info"><div class="t">' + esc(m.name || '组员') + (isAdm ? ' <span class="pill pill-ok">管理员</span>' : '') + (waiting ? ' <span class="pill pill-warn">待接管</span>' : '') + '</div>' +
        '<div class="s">' + esc(m.phone ? Store.maskPhone(m.phone) : '未填手机号') + '</div></div>' +
        ops + '</div>';
    }

    var reqBlock = '';
    if (S.isAdmin) {
      reqBlock = '<div class="card"><div class="card-head"><h2>加入申请</h2><span class="sub">' +
        (pending.length ? pending.length + ' 条待处理' : '暂无待处理') + '</span></div>' +
        '<div class="card-body tight">' +
        (pending.length ? '<div class="item-list">' + pending.map(function (r) {
          return '<div class="item-row">' +
            '<div class="ava" style="width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px">' + esc((r.name || '申').slice(0, 1)) + '</div>' +
            '<div class="main-info"><div class="t">' + esc(r.name) + ' <span class="pill pill-warn">待审</span></div>' +
            '<div class="s">' + esc(r.phone ? Store.maskPhone(r.phone) : '未填手机号') + ' · ' + esc(new Date(r.at).toLocaleString('zh-CN')) + '</div></div>' +
            '<div class="row-ops">' +
            '<button class="btn btn-xs btn-primary" data-act="ok-join" data-id="' + esc(r.reqId) + '">同意</button>' +
            '<button class="btn btn-xs" data-act="no-join" data-id="' + esc(r.reqId) + '">拒绝</button>' +
            '</div></div>';
        }).join('') + '</div>' : emptyBlock('没有新的申请', '组员扫二维码或输组口令后会出现在这里')) +
        (decided.length ? '<div class="req-history">' + decided.map(function (r) {
          return '<div class="req-hrow"><span class="pill ' + (r.status === 'approved' ? 'pill-ok' : r.status === 'rejected' ? 'pill-warn' : 'pill-mute') + '">' +
            (r.status === 'approved' ? '已通过' : r.status === 'rejected' ? '已拒绝' : '已撤销') + '</span>' +
            esc(r.name) + ' · ' + esc(r.phone ? Store.maskPhone(r.phone) : '—') + '</div>';
        }).join('') + '</div>' : '') +
        '</div></div>';
    }

    return errBanner() +

      /* ---- 导出：放在最上面，一眼能看到 ---- */
      '<div class="card card-hl"><div class="card-head"><h2>导出台账</h2><span class="sub">Excel · 两张表</span></div><div class="card-body">' +
      '<div class="export-hero">' +
      '<div class="export-txt"><b>导出 Excel 台账</b>' +
      '<span>生成标准 .xlsx：表1「库存台账」、表2「出入库流水」，带标题、合计行、冻结表头、跨页重复表头、A4 横向与页码，可直接打印归档。</span></div>' +
      '<button class="btn btn-primary export-btn" data-act="export-xlsx">导出 Excel</button>' +
      '</div>' +
      '<div class="export-sub">' +
      '<button class="btn btn-sm" data-act="export-csv">导出流水（CSV）</button>' +
      '<button class="btn btn-sm" data-act="export-json">全量备份（JSON）</button>' +
      '<button class="btn btn-sm" data-act="print">打印当前页</button>' +
      '</div>' +
      '</div></div>' +

      /* ---- 我的小组：多组切换 / 退出 / 加入 ---- */
      '<div class="card"><div class="card-head"><h2>我的小组</h2>' +
      '<span class="sub">' + ((S.teams || []).length > 1 ? '已加入 ' + S.teams.length + ' 个 · 点「进入」切换工作台' : '一个账号可以加入多个小组') + '</span>' +
      '<div class="spacer"></div><button class="btn btn-sm hide-sm" data-act="refresh">刷新</button></div>' +
      '<div class="card-body tight">' + teamListHtml() + '</div>' +
      '<div class="card-foot-bar block">' + joinFormHtml() + '</div></div>' +

      '<div class="cols-2">' +
      /* ---- 账号 ---- */
      '<div class="card"><div class="card-head"><h2>我的账号</h2><span class="sub">' + (noPwd ? '未设云端密码' : '可跨设备登录') + '</span></div><div class="card-body">' +
      '<div class="field"><label>手机号（即用户名）</label>' +
      '<div class="input-group"><input value="' + esc(myPhone || '—') + '" readonly>' +
      '<button class="btn btn-sm btn-primary" data-act="set-password">' + (acct ? '改密码' : '设密码') + '</button></div>' +
      '<div class="tip">一个手机号就是一个账号。设好密码后，换手机也能直接用手机号 + 密码登录。</div></div>' +
      '<div class="field"><label>登录密码</label>' +
      '<div class="tip" style="margin-top:0;line-height:1.9">' +
      '状态：' + (noPwd ? '<b style="color:#b45309">还没设过密码，目前只能用短信验证码登录</b>' : '已设置（' + (Store.isUnlocked() ? '本机已记住，免密中' : '每次打开需输入') + '）') +
      '</div></div>' +
      '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:4px">' +
      '<button class="btn btn-sm" data-act="lock">锁定本机</button>' +
      '<button class="btn btn-sm btn-danger" data-act="logout">退出登录</button>' +
      '</div>' +
      '<div class="tip" style="margin-top:9px">锁定只是暂时挡住界面；退出登录会清除本机登录信息，回到手机号 + 密码登录页。</div></div></div>' +

      /* ---- 小组 ---- */
      '<div class="card"><div class="card-head"><h2>小组信息</h2><span class="sub">' + members.length + ' 人</span></div><div class="card-body">' +
      '<div class="field"><label>小组名称</label>' +
      '<div class="input-group">' +
      '<input value="' + esc(S.team.name) + '" readonly>' +
      (S.isAdmin ? '<button class="btn btn-sm btn-primary" data-act="rename-team">重命名</button>' : '') +
      '</div>' +
      '<div class="tip">' + (S.isAdmin ? '只有管理员可以修改。改名后全组成员看到的都是新名字，台账与流水不受影响。' : '小组名称由管理员维护，需要改动可以找管理员。') + '</div></div>' +
      '<div class="field"><label>组口令（发给组员）</label>' +
      '<div class="input-group"><input value="' + esc(S.team.code || '') + '" readonly>' +
      '<button class="btn btn-sm" data-act="copy-code">复制</button>' +
      '<button class="btn btn-sm btn-primary" data-act="show-qr">二维码</button></div>' +
      '<div class="tip">组员扫码或输口令提交申请，你在这里点「同意」后才进组。</div></div>' +
      '<div class="field"><label>我的显示名</label>' +
      '<div class="input-group"><input id="disp-name" value="' + esc(myName()) + '" placeholder="例如：阎宗宁"><button class="btn btn-sm" data-act="save-name">保存</button></div></div>' +
      '</div></div>' +
      '</div>' +

      reqBlock +

      /* ---- 成员 ---- */
      '<div class="card"><div class="card-head"><h2>小组成员</h2><span class="sub">' + members.length + ' 人' + (S.isAdmin ? ' · 你是管理员，可增减成员、转让管理员' : '') + '</span></div>' +
      '<div class="card-body tight">' +
      (members.length ? '<div class="item-list">' + members.map(memberRow).join('') + '</div>' : emptyBlock('暂无成员', '')) +
      '</div>' +
      '<div class="card-foot-bar">' +
      (S.isAdmin
        ? '<button class="btn btn-sm" data-act="show-qr">邀请成员（二维码）</button><button class="btn btn-sm" data-act="refresh">刷新成员</button>'
        : '<button class="btn btn-sm" data-act="refresh">刷新成员</button>') +
      '</div></div>' +

      '<div class="card"><div class="card-head"><h2>低库存预警线</h2><span class="sub">' +
      (lowKinds ? lowKinds + ' 种已触发' : '暂未触发') + (noLine ? ' · ' + noLine + ' 种未设' : '') + '</span>' +
      '<div class="spacer"></div><button class="btn btn-sm btn-primary" data-act="min-stock">批量设置</button></div>' +
      '<div class="card-body"><div style="font-size:12.5px;color:var(--muted);line-height:1.85">' +
      '库存小于或等于预警线时，概览和台账会标黄提醒。入库时可以顺手设，也可以在这里一次改完所有试剂（填 0 表示不预警）。' +
      '</div></div></div>' +

      '<div class="cols-2">' +
      '<div class="card"><div class="card-head"><h2>单位</h2><span class="sub">每行一个，入库时可点选</span></div><div class="card-body">' +
      '<textarea id="cfg-units" style="width:100%;min-height:140px;padding:11px;border:1px solid var(--line);border-radius:10px;line-height:1.9">' + esc(listVal(cfg.units)) + '</textarea>' +
      '<button class="btn btn-sm btn-primary" style="margin-top:10px" data-act="save-units">保存单位</button></div></div>' +
      '<div class="card"><div class="card-head"><h2>试剂分类</h2><span class="sub">每行一个</span></div><div class="card-body">' +
      '<textarea id="cfg-cats" style="width:100%;min-height:140px;padding:11px;border:1px solid var(--line);border-radius:10px;line-height:1.9">' + esc(listVal(cfg.categories)) + '</textarea>' +
      '<button class="btn btn-sm btn-primary" style="margin-top:10px" data-act="save-cats">保存分类</button></div></div>' +
      '</div>' +

      '<div class="card"><div class="card-head"><h2>存放位置</h2><span class="sub">每行一个，入库时会提示</span></div><div class="card-body">' +
      '<textarea id="cfg-locs" style="width:100%;min-height:110px;padding:11px;border:1px solid var(--line);border-radius:10px;line-height:1.9">' + esc(listVal(cfg.locations)) + '</textarea>' +
      '<button class="btn btn-sm btn-primary" style="margin-top:10px" data-act="save-locs">保存位置</button></div></div>' +

      '<div class="card"><div class="card-head"><h2>同步</h2></div><div class="card-body">' +
      '<div style="font-size:12px;color:var(--hint);line-height:1.8">' +
      '数据实时保存在云端，所有组员共享同一份。当前设备缓存最近一次同步结果，断网时可只读查看。<br>' +
      '最近同步：' + (S.lastSync ? new Date(S.lastSync).toLocaleString('zh-CN') : '尚未同步') + '</div>' +
      '</div></div>' +

      /* ---- 版本（放在最底部） ---- */
      '<div class="card ver-card"><div class="card-head"><h2>版本</h2><span class="sub">更新后这里会变</span>' +
      '<div class="spacer"></div><button class="btn btn-sm" data-act="check-update">检查更新</button></div>' +
      '<div class="card-body">' +
      '<div class="ver-grid">' +
      '<div class="ver-item"><span>前台版本</span><b>v' + esc(APP_VER) + '</b></div>' +
      '<div class="ver-item"><span>构建</span><b>' + esc(fmtBuild(APP_BUILD)) + '</b></div>' +
      '<div class="ver-item"><span>数据同步</span><b>' + (S.lastSync ? esc(new Date(S.lastSync).toLocaleString('zh-CN')) : '尚未同步') + '</b></div>' +
      '</div>' +
      '<div class="tip" style="margin-top:10px">如果在微信里看到的是旧界面，点右上角「检查更新」会强制拉一次最新版本；仍不行就把链接后面的 <code>?v=</code> 参数改掉再打开。</div>' +
      '</div></div>';
  }

  /* 20261122-2220 → 2026-11-22 22:20 */
  function fmtBuild(s) {
    var m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    return m ? (m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5]) : String(s || '—');
  }

  /* ---------------- 弹窗 ---------------- */
  function ensureModalRoot() {
    var m = document.getElementById('modal-root');
    if (!m) {
      m = document.createElement('div');
      m.id = 'modal-root';
      document.body.appendChild(m);
    }
    return m;
  }
  function closeModal() {
    var m = document.getElementById('modal-root');
    if (m) m.innerHTML = '';
  }
  function openModal(title, bodyHtml, footHtml) {
    var m = ensureModalRoot();
    m.innerHTML = '<div class="modal-mask" data-act="mask-close"><div class="modal">' +
      '<div class="modal-head"><h3>' + esc(title) + '</h3><div class="spacer"></div><button class="x" data-act="close-modal">✕</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '') +
      '</div></div>';
  }

  function openReagentForm(id) {
    var r = id ? S.reagents.filter(function (x) { return x.id === id; })[0] : null;
    var cfg = Store.settings();
    var body = '<div class="field"><label>试剂名称 *</label><input id="rf-name" value="' + esc(r ? r.name : '') + '" placeholder="如：无水乙醇"></div>' +
      '<div class="row2">' +
      '<div class="field"><label>分类</label><select id="rf-cat"><option value="">未分类</option>' +
      cfg.categories.map(function (c) { return '<option' + (r && r.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>规格</label><input id="rf-spec" value="' + esc(r ? r.spec : '') + '" placeholder="500 mL/瓶"></div>' +
      '<div class="field"><label>CAS 号</label><input id="rf-cas" value="' + esc(r ? r.cas : '') + '" placeholder="选填"></div>' +
      '<div class="field"><label>单位</label><input id="rf-unit" list="rf-unit-list" value="' + esc(r ? r.unit : cfg.units[0]) + '" placeholder="瓶 / mL / g">' +
      '<datalist id="rf-unit-list">' + cfg.units.map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist></div>' +
      '<div class="field"><label>低库存预警线</label><input id="rf-min" type="number" step="any" value="' + esc(r ? r.min_stock : '') + '" placeholder="0"></div>' +
      '<div class="field"><label>存放位置</label><input id="rf-loc" value="' + esc(r ? r.location : '') + '" placeholder="如 试剂柜 A"></div>' +
      '</div>' +
      '<div class="field"><label>安全提示</label><input id="rf-safety" value="' + esc(r ? r.safety : '') + '" placeholder="如 易燃 / 易制毒 / 通风橱操作"></div>' +
      '<div class="field"><label>备注</label><textarea id="rf-note">' + esc(r ? r.note : '') + '</textarea></div>' +
      '<div class="err" id="rf-err"></div>';
    var foot = '<button class="btn" data-act="close-modal">取消</button>' +
      (r ? '<button class="btn btn-danger" data-act="del-reagent" data-id="' + r.id + '">删除</button>' : '') +
      '<button class="btn btn-primary" data-act="save-reagent" data-id="' + (r ? r.id : '') + '">保存</button>';
    openModal(r ? '编辑试剂' : '新增试剂', body, foot);
  }

  /* ---------------- 低库存预警线（批量设置） ---------------- */
  function openMinStockModal() {
    var rs = liveReagents().slice().sort(function (a, b) {
      return String(a.category || 'zz').localeCompare(String(b.category || 'zz'), 'zh') ||
        String(a.name || '').localeCompare(String(b.name || ''), 'zh');
    });
    if (!rs.length) {
      openModal('低库存预警线', emptyBlock('还没有试剂', '先在台账里新增试剂或做一次入库'), '<button class="btn" data-act="close-modal">关闭</button>');
      return;
    }
    var rows = rs.map(function (r) {
      var t = stockOf(r.id);
      var st = reagentStatus(r);
      return '<div class="ms-row" data-rid="' + r.id + '">' +
        '<div class="ms-name"><div class="t">' + esc(r.name) +
        (U.n(r.min_stock) > 0 && t <= U.n(r.min_stock) ? ' <span class="pill ' + st.cls + '">' + st.label + '</span>' : '') +
        '</div><div class="s">' + [r.spec, r.category].filter(Boolean).map(esc).join(' · ') +
        (r.spec || r.category ? ' · ' : '') + '当前 ' + num(t) + ' ' + esc(r.unit || '') + '</div></div>' +
        '<div class="qty ms-qty"><input class="ms-input" type="number" step="any" inputmode="decimal" value="' + esc(U.n(r.min_stock) || '') + '" placeholder="0"><span class="qty-u">' + esc(r.unit || '') + '</span></div>' +
        '</div>';
    }).join('');
    openModal('低库存预警线',
      '<div class="banner banner-info">库存 ≤ 预警线时提醒。填 0 或留空表示不预警。改完点「保存全部」。</div>' +
      '<div class="ms-list">' + rows + '</div>',
      '<button class="btn" data-act="close-modal">取消</button>' +
      '<button class="btn btn-primary" data-act="save-min-stock">保存全部</button>');
  }

  /* ---------------- 本机设置登录密码 ---------------- */
  function openPwdForm() {
    var acc = S.account || {};
    var has = !!acc.hash;
    var phone = Store.maskPhone(S.phone || acc.phone || '');
    openModal('登录密码',
      '<div class="field"><label>账号手机号</label><input value="' + esc(phone || '—') + '" readonly></div>' +
      (has ? '<div class="field"><label>当前密码</label><input id="pw-old" type="password" autocomplete="current-password" placeholder="输入现在用的密码"></div>' : '') +
      '<div class="field"><label>新密码</label><input id="pw-new" type="password" autocomplete="new-password" placeholder="至少 6 位"></div>' +
      '<div class="field"><label>确认新密码</label><input id="pw-new2" type="password" autocomplete="new-password" placeholder="再输一次"></div>' +
      '<div class="tip" style="font-size:11.5px;color:var(--hint);line-height:1.7">这个密码用于打开台账。设好后会顺带尝试写入云端，成功的话换台手机也能直接用手机号 + 密码登录。</div>' +
      '<div class="err" id="pw-err"></div>',
      '<button class="btn" data-act="close-modal">取消</button><button class="btn btn-primary" data-act="do-save-pwd">保存</button>');
  }

  /* ---------------- 邀请二维码 ---------------- */
  function inviteUrl() {
    var code = (S.team && S.team.code) || '';
    try {
      var u = new URL(location.href);
      u.searchParams.set('join', code);
      /* 带上版本号：扫码的人拿到的是新 URL，不会被微信旧缓存命中 */
      u.searchParams.set('v', APP_BUILD);
      return u.toString();
    } catch (e) {
      return location.origin + location.pathname + '?join=' + encodeURIComponent(code) + '&v=' + encodeURIComponent(APP_BUILD);
    }
  }

  function qrSvg(text) {
    if (!window.qrcode) throw new Error('二维码组件未加载');
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount(), cell = 8, pad = 16, size = n * cell + pad * 2, d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + (pad + c * cell) + ' ' + (pad + r * cell) + 'h' + cell + 'v' + cell + 'h-' + cell + 'z';
      }
    }
    return '<svg class="qr-svg" viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">' +
      '<rect width="' + size + '" height="' + size + '" fill="#ffffff"/>' +
      '<path d="' + d + '" fill="#0f172a"/></svg>';
  }

  function openQrModal() {
    var code = (S.team && S.team.code) || '';
    var url = inviteUrl();
    var svg;
    try { svg = qrSvg(url); }
    catch (e) {
      svg = '<div class="qr-fail">二维码生成失败，请让组员直接输入组口令：<b>' + esc(code) + '</b></div>';
    }
    openModal('邀请成员',
      '<div class="qr-wrap">' +
      '<div class="qr-box">' + svg + '</div>' +
      '<div class="qr-side">' +
      '<div class="qr-team">' + esc(S.team.name) + '</div>' +
      '<div class="qr-code">组口令 <b>' + esc(code) + '</b></div>' +
      '<div class="qr-tip">组员用微信 / 相机扫码 → 打开后输手机号验证 → 提交申请；你在这里点「同意」就能进组。</div>' +
      '<div class="qr-url">' + esc(url.length > 72 ? url.slice(0, 72) + '…' : url) + '</div>' +
      '</div></div>' +
      '<div class="qr-ops">' +
      '<button class="btn btn-sm" data-act="copy-invite">复制邀请链接</button>' +
      '<button class="btn btn-sm" data-act="copy-code">复制组口令</button>' +
      '</div>',
      '<button class="btn" data-act="close-modal">关闭</button>');
  }

  /* ---------------- 导出 Excel（标准台账） ---------------- */
  function pad2(x) { return (x < 10 ? '0' : '') + x; }
  function nowText() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function stampText() {
    var d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function buildLedgerWorkbook() {
    var XL = window.XLSXLite;
    var C = XL.cell;
    function c(v, s) { return { v: v, s: s == null ? C.text : s }; }
    function n(v, s) { return { v: U.n(v), t: 'n', s: s == null ? C.num : s }; }
    function round2(x) { return Math.round(x * 100) / 100; }

    var teamName = (S.team && S.team.name) || '科研小组';
    var who = myName() || (S.account ? S.account.u : '') || '—';
    var when = nowText();

    /* ---- 表1：库存台账（按试剂 + 批次） ---- */
    var rs = liveReagents().slice().sort(function (a, b) {
      return String(a.category || 'zz').localeCompare(String(b.category || 'zz'), 'zh') ||
        String(a.name || '').localeCompare(String(b.name || ''), 'zh');
    });
    var rows = [], seq = 0, batchN = 0, valueSum = 0;
    rs.forEach(function (r) {
      var bs = batchesOf(r.id);
      if (!bs.length) {
        seq++;
        rows.push([
          c(seq, C.center), c(r.name, C.text), c(r.spec || '', C.text),
          c(r.cas || '', C.center), c(r.category || '未分类', C.center), c(r.unit || '', C.center),
          c('', C.center), c(r.location || '', C.center), c('', C.center),
          n(0), n(0), n(0),
          c('', C.money), c('', C.money), c('', C.text)
        ]);
        return;
      }
      bs.forEach(function (b, i) {
        if (i === 0) seq++;
        batchN++;
        var qin = U.n(b.qty_in);
        var qleft = U.n(b.qty_left);
        var used = Math.round((qin - qleft) * 1000) / 1000;
        var price = (b.price === null || b.price === undefined || b.price === '') ? null : U.n(b.price);
        var amount = price == null ? null : round2(price * qleft);
        if (amount != null) valueSum += amount;
        rows.push([
          c(i === 0 ? seq : '', C.center),
          c(i === 0 ? r.name : '', C.text),
          c(i === 0 ? (r.spec || '') : '', C.text),
          c(i === 0 ? (r.cas || '') : '', C.center),
          c(i === 0 ? (r.category || '未分类') : '', C.center),
          c(i === 0 ? (r.unit || '') : '', C.center),
          c(b.lot_no || '—', C.center),
          c(b.location || r.location || '', C.center),
          c(b.arrive_date ? String(b.arrive_date).slice(0, 10) : '', C.center),
          n(qin), n(used), n(qleft),
          price == null ? c('', C.money) : { v: price, t: 'n', s: C.money },
          amount == null ? c('', C.money) : { v: amount, t: 'n', s: C.money },
          c(b.supplier || '', C.text)
        ]);
      });
    });

    var totals = [];
    for (var i = 0; i < 15; i++) totals.push(null);
    totals[1] = { v: '合计', s: 8 };
    totals[13] = { v: round2(valueSum), t: 'n', s: 10 };

    var signLine = '制表人：' + who + '　　　　审核：　　　　　　　　负责人：　　　　　　　　日期：' + when.slice(0, 10);

    var sheet1 = {
      name: '库存台账',
      title: teamName + '　试剂库存台账',
      subtitle: '导出时间：' + when + '　　制表人：' + who + '　　共 ' + rs.length + ' 种试剂 / ' + batchN + ' 个批次',
      note: [
        '说明：本表由「试剂出入库管理台」自动生成，数据来源于全组共享台账；金额 = 结存数量 × 单价，不同单位的数量不作合计。',
        signLine
      ],
      landscape: true,
      cols: [{ w: 6 }, { w: 22 }, { w: 16 }, { w: 13 }, { w: 11 }, { w: 7 }, { w: 15 }, { w: 14 }, { w: 13 }, { w: 11 }, { w: 9 }, { w: 9 }, { w: 11 }, { w: 13 }, { w: 18 }],
      header: ['序号', '试剂名称', '规格', 'CAS 号', '分类', '单位', '批号', '存放位置', '入库日期', '入库数量', '已领用', '结存', '单价(元)', '金额(元)', '供应商'],
      rows: rows,
      totals: totals
    };

    /* ---- 表2：出入库流水 ---- */
    var tx = liveTxns().slice().sort(function (a, b) {
      return String(a.txn_date || '').localeCompare(String(b.txn_date || '')) ||
        String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    var inN = 0, outN = 0, adjN = 0;
    var trows = tx.map(function (t, idx) {
      if (t.kind === 'in') inN++; else if (t.kind === 'out') outN++; else adjN++;
      var q = U.n(t.qty);
      var signed = t.kind === 'out' ? -Math.abs(q) : (t.kind === 'in' ? Math.abs(q) : q);
      return [
        c(idx + 1, C.center),
        c(String(t.txn_date || '').slice(0, 10), C.center),
        c(t.kind === 'in' ? '入库' : t.kind === 'out' ? '出库' : '盘点调整', C.center),
        c(t.reagent_name || '', C.text),
        c(t.lot_no || '', C.center),
        n(signed),
        c(t.unit || '', C.center),
        c(t.operator_name || '', C.center),
        c(t.purpose || '', C.text),
        c(t.project || '', C.text),
        c(t.note || '', C.text)
      ];
    });

    var sheet2 = {
      name: '出入库流水',
      title: teamName + '　试剂出入库流水',
      subtitle: '导出时间：' + when + '　　共 ' + tx.length + ' 条（入库 ' + inN + ' 笔 / 出库 ' + outN + ' 笔 / 调整 ' + adjN + ' 笔）',
      note: [
        '说明：数量以入库为正、出库为负；「盘点调整」按盘盈（正）/ 盘亏（负）记录。',
        signLine
      ],
      landscape: true,
      cols: [{ w: 6 }, { w: 13 }, { w: 10 }, { w: 22 }, { w: 15 }, { w: 10 }, { w: 7 }, { w: 13 }, { w: 18 }, { w: 15 }, { w: 22 }],
      header: ['序号', '日期', '类型', '试剂名称', '批号', '数量', '单位', '经办人/领用人', '用途', '关联课题', '备注'],
      rows: trows
    };

    var bytes = XL.build({
      title: teamName + ' 试剂出入库台账',
      creator: who,
      sheets: [sheet1, sheet2]
    });

    var safe = teamName.replace(/[\\\/:*?"<>|]/g, '');
    return { bytes: bytes, name: safe + '_试剂台账_' + stampText() + '.xlsx' };
  }

  function downloadBytes(name, bytes, type) {
    var blob = new Blob([bytes], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 600);
  }

  /* ---------------- 提示 ---------------- */
  function toast(text, kind) {
    var w = document.getElementById('toast-root');
    if (!w) { w = document.createElement('div'); w.id = 'toast-root'; w.className = 'toast-wrap'; document.body.appendChild(w); }
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = text;
    w.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function showErr(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
    if (!el) toast(text, 'err');
  }

  /* ---------------- 事件 ---------------- */
  /* 退出 / 换号时把界面状态一并清空，避免残留上一个账号的草稿与筛选 */
  function resetUiState() {
    UI.view = 'overview';
    UI.q = ''; UI.cat = ''; UI.st = '';
    UI.txnKind = 'all'; UI.txnFrom = ''; UI.txnTo = ''; UI.txnQ = '';
    UI.draftIn = null; UI.draftOut = null; UI.adjust = {}; UI.expanded = {};
    UI.authMode = ''; UI.otpInfo = null; UI.resetInfo = null;
    UI.qrCode = ''; UI.qrPhone = ''; UI.teamMode = 'join';
    UI.pendingRender = false;
    if (UI.pollTimer) { clearInterval(UI.pollTimer); UI.pollTimer = null; }
  }

  function fieldVal(form, name) {
    var el = form.querySelector('[data-bind="' + name + '"]');
    return el ? el.value : '';
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');

    if (act === 'mask-close') { if (e.target === t) closeModal(); return; }
    if (act === 'close-modal') { closeModal(); return; }

    if (act === 'team-mode') { UI.teamMode = t.getAttribute('data-mode'); render(); return; }
    if (act === 'go') { UI.view = t.getAttribute('data-view'); window.scrollTo(0, 0); render(); return; }
    if (act === 'refresh') {
      var jobs = [Store.pull(), Store.refreshMyRole().then(function () { return Store.loadMembers(); })];
      Promise.all(jobs).then(function () { toast('已刷新', 'ok'); })
        .catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'reboot') { Store.boot(); return; }
    if (act === 'use-otp') { UI.authMode = 'otp'; UI.otpInfo = null; render(); return; }
    if (act === 'back-login') { UI.authMode = ''; UI.otpInfo = null; UI.resetInfo = null; render(); return; }
    if (act === 'skip-newpwd') { Store.setSkip(true); UI.authMode = ''; render(true); toast('可随时在「我的账号」里设置密码'); return; }
    if (act === 'go-reset') { UI.authMode = 'reset'; UI.resetInfo = { phone: S.phone || '' }; render(); return; }
    if (act === 'lock') {
      UI.view = 'overview'; UI.draftIn = null; UI.draftOut = null;
      if (!S.account) { toast('还没设登录密码，请先在「我的账号」里设一个', 'err'); return; }
      Store.lockScreen();
      toast('已锁定，输入手机号和密码可再次进入');
      return;
    }
    if (act === 'logout') {
      if (!confirm('退出登录会清除本机登录信息（台账数据仍在云端），下次需要重新用手机号和密码登录。确定退出？')) return;
      Store.logout().then(function () {
        resetUiState();
        closeModal();
        toast('已退出登录', 'ok');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'transfer-admin') {
      var tn = t.getAttribute('data-name') || '该组员';
      openModal('转让管理员',
        '<div class="field"><label>接收人</label><input value="' + esc(tn) + '" readonly></div>' +
        '<div class="banner banner-warn" style="margin-bottom:10px">转让需要对方同意才生效。对方接受后你变成组员，' + esc(tn) + ' 成为管理员（可审批加入、移除成员、删除流水）。</div>' +
        '<div class="err" id="tr-err"></div>',
        '<button class="btn" data-act="close-modal">取消</button>' +
        '<button class="btn btn-primary" data-act="do-transfer" data-id="' + esc(id) + '" data-name="' + esc(tn) + '">发出转让请求</button>');
      return;
    }
    if (act === 'do-transfer') {
      showErr('tr-err', '提交中…');
      Store.requestAdminTransfer(id).then(function () {
        closeModal();
        toast('已发出，等对方确认后生效', 'ok');
        render(true);
      }).catch(function (err) { showErr('tr-err', U.msg(err)); });
      return;
    }
    if (act === 'accept-transfer') {
      if (!confirm('接受后你将成为小组管理员，对方变为组员。确定接受？')) return;
      Store.respondAdminTransfer(true).then(function () {
        toast('已接受，你现在是管理员', 'ok');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'reject-transfer') {
      Store.respondAdminTransfer(false).then(function () {
        toast('已拒绝这次转让');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'cancel-transfer') {
      Store.cancelAdminTransfer().then(function () {
        toast('已撤回转让请求');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'switch-team') { openTeamSwitchModal(); return; }
    if (act === 'do-switch-team') {
      var stName = t.getAttribute('data-name') || '该小组';
      t.disabled = true;
      Store.switchTeam(id).then(function () {
        closeModal();
        resetUiState();
        UI.view = 'settings';
        toast('已切换到「' + stName + '」', 'ok');
        render(true);
      }).catch(function (err) {
        t.disabled = false;
        toast(U.msg(err), 'err');
      });
      return;
    }
    if (act === 'leave-team') {
      var lid = id || (S.team && S.team.id);
      var lname = t.getAttribute('data-name') || '该小组';
      var isCur = !!(S.team && S.team.id === lid);
      openModal('退出小组「' + lname + '」',
        '<div class="banner banner-warn">' +
        (isCur
          ? '退出后你的账号和手机号都在，随时可以用组口令重新申请加入；该小组的台账、流水、成员不受影响。'
          : '将退出这个小组，它的台账与流水保留在原小组内，不会删除。') +
        '</div>' +
        '<div class="tip" style="margin-top:12px;line-height:1.8">' +
        '· 如果你是该组唯一的管理员、且组里还有其他成员，需要先在成员列表里把管理员转让出去；<br>' +
        '· 组里只剩你一个人时可以直接退出，空小组会被自动清理。' +
        '</div>' +
        '<div class="err" id="lv-err"></div>',
        '<button class="btn" data-act="close-modal">取消</button>' +
        '<button class="btn btn-danger" data-act="do-leave-team" data-id="' + esc(lid) + '">确认退出</button>');
      return;
    }
    if (act === 'do-leave-team') {
      showErr('lv-err', '处理中…');
      Store.leaveTeam(id).then(function (r) {
        closeModal();
        resetUiState();
        if (S.team) UI.view = 'settings';
        toast(r && r.switched ? '已退出，已切到「' + r.switched.name + '」' : '已退出小组', 'ok');
        render(true);
      }).catch(function (err) { showErr('lv-err', U.msg(err)); });
      return;
    }
    if (act === 'min-stock') { openMinStockModal(); return; }
    if (act === 'check-update') {
      var cbtn = t;
      cbtn.disabled = true; cbtn.textContent = '检查中…';
      try { sessionStorage.removeItem('rio_build_try'); } catch (e) { }
      /* 资源请求要带上分享码，否则在微信/无 Cookie 环境会被网关拦成 403 */
      var vurl = window.assetUrl
        ? window.assetUrl('version.json?t=' + Date.now())
        : 'version.json?t=' + Date.now();
      fetch(vurl, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (j && j.build && j.build !== APP_BUILD) {
            var nu = new URL(location.href);
            nu.searchParams.set('v', j.build);
            toast('发现新版本，正在更新…', 'ok');
            setTimeout(function () { location.replace(nu.toString()); }, 600);
          } else {
            cbtn.disabled = false; cbtn.textContent = '检查更新';
            toast('已是最新版本（' + fmtBuild(APP_BUILD) + '）', 'ok');
          }
        })
        .catch(function () {
          cbtn.disabled = false; cbtn.textContent = '检查更新';
          toast('检查失败，请检查网络后重试', 'err');
        });
      return;
    }    if (act === 'save-min-stock') {
      var msList = [].slice.call(document.querySelectorAll('.ms-row')).map(function (row) {
        var inp = row.querySelector('.ms-input');
        return { id: row.getAttribute('data-rid'), min_stock: inp ? inp.value : '' };
      });
      if (!msList.length) { closeModal(); return; }
      Store.setMinStocks(msList).then(function (cnt) {
        closeModal();
        toast('已保存 ' + cnt + ' 条预警线', 'ok');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'del-txn') {
      var dt = S.txns.filter(function (x) { return x.id === id; })[0];
      if (!dt) return;
      var dkLabel = dt.kind === 'in' ? '入库' : dt.kind === 'out' ? '出库' : '盘点调整';
      openModal('删除流水（管理员）',
        '<div class="pend-box" style="margin-bottom:12px">' +
        '<div class="pend-row"><span>类型</span><b>' + dkLabel + '</b></div>' +
        '<div class="pend-row"><span>试剂</span><b>' + esc(dt.reagent_name || '—') + '</b></div>' +
        '<div class="pend-row"><span>批号</span><b>' + esc(dt.lot_no || '—') + '</b></div>' +
        '<div class="pend-row"><span>数量</span><b>' + num(Math.abs(U.n(dt.qty))) + ' ' + esc(dt.unit || '') + '</b></div>' +
        '<div class="pend-row"><span>日期</span><b>' + fmtDate(dt.txn_date) + '</b></div>' +
        '</div>' +
        '<div class="banner banner-danger">删除会同时纠正库存：出库流水删除 → 数量退回批次；入库流水删除 → 该批次一并作废（仅限还没被领用的批次）；盘点调整删除 → 库存回退到调整前。</div>' +
        '<div class="field" style="margin-top:12px"><label>删除原因（留档）</label><input id="dt-reason" placeholder="如：录错试剂，重新登记"></div>' +
        '<div class="err" id="dt-err"></div>',
        '<button class="btn" data-act="close-modal">取消</button>' +
        '<button class="btn btn-danger" data-act="do-del-txn" data-id="' + esc(dt.id) + '">确认删除</button>');
      return;
    }
    if (act === 'do-del-txn') {
      var dtr = document.getElementById('dt-reason');
      showErr('dt-err', '处理中…');
      Store.deleteTxn(id, dtr ? dtr.value : '').then(function () {
        closeModal();
        toast('流水已删除，库存已同步', 'ok');
        render(true);
      }).catch(function (err) { showErr('dt-err', U.msg(err)); });
      return;
    }
    if (act === 'switch-account') {
      if (!confirm('换个手机号会退出当前账号并清除本机登录信息，下次需要用手机号验证。确定？')) return;
      Store.switchAccount().then(function () {
        resetUiState();
        UI.authMode = 'otp'; UI.otpInfo = null; UI.resetInfo = null;
        toast('已退出，请用手机号登录');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'set-password') { openPwdForm(); return; }
    if (act === 'do-save-pwd') {
      var p1 = document.getElementById('pw-new').value;
      var p2 = document.getElementById('pw-new2').value;
      var oldEl = document.getElementById('pw-old');
      if (!p1 || p1.length < 6) { showErr('pw-err', '密码至少 6 位'); return; }
      if (p1 !== p2) { showErr('pw-err', '两次输入的密码不一致'); return; }
      var save = function () {
        showErr('pw-err', '保存中…');
        return Store.saveAccount(S.phone || (S.account && S.account.phone) || '', p1, myName(), !!(S.account && S.account.cloudPwd))
          .then(function () {
            return Store.trySyncCloudPwd(p1);
          })
          .then(function (ok) {
            if (ok) Store.markCloudPwd();
            Store.unlock(30);
            closeModal(); render(true);
            toast(ok ? '密码已保存，换手机也能登录' : '密码已保存在本机', 'ok');
          });
      };
      if (oldEl && oldEl.value) {
        Store.checkPassword(S.phone || '', oldEl.value).then(function (ok) {
          if (!ok) { showErr('pw-err', '当前密码不正确'); return; }
          save().catch(function (err) { showErr('pw-err', U.msg(err)); });
        });
      } else if (oldEl && !oldEl.value && S.account && S.account.hash) {
        showErr('pw-err', '请输入当前密码');
      } else {
        save().catch(function (err) { showErr('pw-err', U.msg(err)); });
      }
      return;
    }
    if (act === 'show-qr') { openQrModal(); return; }
    if (act === 'copy-invite') {
      var iu = inviteUrl();
      if (navigator.clipboard) navigator.clipboard.writeText(iu).then(function () { toast('邀请链接已复制', 'ok'); });
      else prompt('复制邀请链接：', iu);
      return;
    }
    if (act === 'check-pending') {
      Store.checkPending().then(function (ok) {
        if (ok) { toast('管理员已通过，已进入小组', 'ok'); render(true); }
        else toast('还在等待管理员确认');
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'cancel-pending') {
      S.pendingJoin = null;
      UI.teamMode = 'join';
      UI.qrCode = '';
      render(true);
      return;
    }
    if (act === 'ok-join' || act === 'no-join') {
      var okFlag = act === 'ok-join';
      Store.decideJoin(id, okFlag).then(function () {
        toast(okFlag ? '已通过，对方刷新后即可进入' : '已拒绝', 'ok');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'del-member') {
      var dn = t.getAttribute('data-name') || '该成员';
      if (!confirm('把「' + dn + '」移出小组？移出后他需要重新提交申请才能再进。')) return;
      Store.removeMember(id).then(function () { toast('已移出', 'ok'); render(true); })
        .catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'toggle-role') {
      var nextRole = t.getAttribute('data-role');
      Store.setMemberRole(id, nextRole).then(function () {
        toast(nextRole === 'admin' ? '已设为管理员' : '已取消管理员', 'ok');
        render(true);
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'print') { window.print(); return; }

    if (act === 'send-code') {
      var form = t.closest('form');
      var phoneRaw = fieldVal(form, 'phone');
      var pn = Store.normPhone(phoneRaw);
      var errEl = document.getElementById('login-err');
      if (!pn) { if (errEl) errEl.textContent = '请输入正确的 11 位手机号'; return; }
      if (errEl) errEl.textContent = '';
      t.disabled = true; t.textContent = '发送中…';
      Store.sendOtp(pn).then(function (data) {
        UI.otpInfo = {
          phone: pn,
          verificationId: data && data.verificationId,
          isExistingUser: !!(data && data.isExistingUser),
          sent: true
        };
        toast('验证码已发送', 'ok');
        render(true);
        var left = 60;
        var tick = setInterval(function () {
          left--;
          var btn = document.querySelector('[data-act="send-code"]');
          if (!btn) { clearInterval(tick); return; }
          if (left <= 0) { clearInterval(tick); btn.disabled = false; btn.textContent = '重新发送'; }
          else btn.textContent = left + 's';
        }, 1000);
      }).catch(function (err) {
        t.disabled = false; t.textContent = '获取验证码';
        if (errEl) errEl.textContent = U.msg(err);
      });
      return;
    }

    if (act === 'send-reset-code') {
      var rf = t.closest('form');
      var rp = Store.normPhone(fieldVal(rf, 'phone'));
      var rerr = document.getElementById('login-err');
      if (!rp) { if (rerr) rerr.textContent = '请输入正确的 11 位手机号'; return; }
      if (rerr) rerr.textContent = '';
      t.disabled = true; t.textContent = '发送中…';
      Store.cloudPwdStart(rp).then(function (vid) {
        UI.resetInfo = { phone: rp, vid: vid };
        toast('验证码已发送', 'ok');
        render(true);
        var left = 60;
        var tick2 = setInterval(function () {
          left--;
          var btn = document.querySelector('[data-act="send-reset-code"]');
          if (!btn) { clearInterval(tick2); return; }
          if (left <= 0) { clearInterval(tick2); btn.disabled = false; btn.textContent = '重新发送'; }
          else btn.textContent = left + 's';
        }, 1000);
      }).catch(function (err) {
        t.disabled = false; t.textContent = '获取验证码';
        if (rerr) rerr.textContent = '这条通道暂时不可用（' + U.msg(err) + '）。可以直接「首次使用」用验证码登录，进入后在我的账号里设密码。';
      });
      return;
    }

    if (act === 'new-reagent') { openReagentForm(''); return; }
    if (act === 'edit-reagent') { openReagentForm(id); return; }
    if (act === 'toggle') {
      if (e.target.closest('button')) return;
      UI.expanded[id] = !UI.expanded[id];
      var z = document.getElementById('inv-zone');
      if (z) z.innerHTML = inventoryTable(); else render();
      return;
    }
    if (act === 'quick-in') {
      UI.draftIn = blankIn();
      UI.draftIn.reagentId = id;
      var rg = S.reagents.filter(function (x) { return x.id === id; })[0];
      if (rg) { UI.draftIn.unit = rg.unit; UI.draftIn.location = rg.location; }
      UI.view = 'inbound'; render(); return;
    }
    if (act === 'quick-out') {
      UI.draftOut = blankOut();
      UI.draftOut.reagentId = id;
      UI.view = 'outbound'; render(); return;
    }
    if (act === 'reset-in') { UI.draftIn = blankIn(); render(); return; }
    if (act === 'fill-first') {
      var d = UI.draftOut;
      var bs = batchesOf(d.reagentId).filter(function (b) { return U.n(b.qty_left) > 0; });
      if (bs.length) { d.items = {}; d.items[bs[0].id] = U.n(bs[0].qty_left); render(); }
      return;
    }
    if (act === 'clear-items') { UI.draftOut.items = {}; render(); return; }
    if (act === 'clear-adjust') { UI.adjust = {}; render(); return; }

    if (act === 'save-reagent') {
      var body = {
        id: id || undefined,
        name: document.getElementById('rf-name').value,
        category: document.getElementById('rf-cat').value,
        spec: document.getElementById('rf-spec').value,
        cas: document.getElementById('rf-cas').value,
        unit: document.getElementById('rf-unit').value,
        min_stock: document.getElementById('rf-min').value,
        location: document.getElementById('rf-loc').value,
        safety: document.getElementById('rf-safety').value,
        note: document.getElementById('rf-note').value
      };
      Store.saveReagent(body).then(function () {
        closeModal(); toast(id ? '已保存' : '已新增', 'ok');
      }).catch(function (err) { showErr('rf-err', U.msg(err)); });
      return;
    }
    if (act === 'del-reagent') {
      if (!confirm('删除后该试剂及其所有批次将从台账隐藏，历史流水仍保留。确定删除？')) return;
      Store.removeReagent(id).then(function () { closeModal(); toast('已删除', 'ok'); })
        .catch(function (err) { showErr('rf-err', U.msg(err)); });
      return;
    }
    if (act === 'adjust') {
      var b = S.batches.filter(function (x) { return x.id === id; })[0];
      if (!b) return;
      var r2 = S.reagents.filter(function (x) { return x.id === b.reagent_id; })[0];
      openModal('盘点调整 · ' + (r2 ? r2.name : ''),
        '<div class="field"><label>账面剩余</label><input value="' + num(b.qty_left) + ' ' + esc(b.unit || '') + '" readonly></div>' +
        '<div class="field"><label>实盘数量</label><input id="adj-qty" type="number" step="any" value="' + num(b.qty_left) + '"></div>' +
        '<div class="field"><label>备注</label><input id="adj-note" placeholder="选填"></div>' +
        '<div class="err" id="adj-err"></div>',
        '<button class="btn" data-act="close-modal">取消</button><button class="btn btn-primary" data-act="do-adjust" data-id="' + id + '">提交调整</button>');
      return;
    }
    if (act === 'do-adjust') {
      Store.adjustBatch({ batchId: id, qty: document.getElementById('adj-qty').value, note: document.getElementById('adj-note').value, operator_name: myName() })
        .then(function () { closeModal(); toast('已生成调整流水', 'ok'); })
        .catch(function (err) { showErr('adj-err', U.msg(err)); });
      return;
    }
    if (act === 'apply-adjust') {
      var v = UI.adjust[id];
      if (v == null || v === '') return;
      Store.adjustBatch({ batchId: id, qty: v, operator_name: myName() }).then(function () {
        delete UI.adjust[id]; toast('已提交', 'ok');
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'void-batch') {
      if (!confirm('作废后该批次将从台账移除，入库流水一并作废。确定？')) return;
      Store.voidBatch(id).then(function () { toast('已作废', 'ok'); }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'undo') {
      if (!confirm('撤销后数量会退回对应批次。确定撤销这笔出库？')) return;
      Store.undoOut(id).then(function () { toast('已撤销，数量已退回', 'ok'); }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'copy-code') {
      var code = S.team.code || '';
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { toast('口令已复制', 'ok'); });
      else { prompt('复制口令：', code); }
      return;
    }
    if (act === 'save-name') {
      var nm = document.getElementById('disp-name').value;
      Store.setDisplayName(nm).then(function () {
        toast('已保存', 'ok');
        if (UI.draftIn) UI.draftIn.operator_name = nm;
        if (UI.draftOut) UI.draftOut.operator_name = nm;
      }).catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'save-cats' || act === 'save-units' || act === 'save-locs') {
      var map = { 'save-cats': ['cfg-cats', 'categories'], 'save-units': ['cfg-units', 'units'], 'save-locs': ['cfg-locs', 'locations'] };
      var pair = map[act];
      var arr = document.getElementById(pair[0]).value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      var patch = {}; patch[pair[1]] = arr;
      Store.saveTeamSettings(patch).then(function () { toast('已保存', 'ok'); })
        .catch(function (err) { toast(U.msg(err), 'err'); });
      return;
    }
    if (act === 'rename-team') {
      openRenameModal();
      return;
    }
    if (act === 'do-rename-team') {
      var rnEl = document.getElementById('rn-name');
      var nm = (rnEl && rnEl.value || '').trim();
      if (!nm) { showErr('rn-err', '小组名称不能为空'); return; }
      if (nm.length > 40) { showErr('rn-err', '小组名称最多 40 个字'); return; }
      if (S.team && nm === S.team.name) { closeModal(); return; }
      showErr('rn-err', '保存中…');
      Store.renameTeam(nm).then(function () {
        closeModal();
        toast('小组名称已更新', 'ok');
        render(true);
      }).catch(function (err) { showErr('rn-err', U.msg(err)); });
      return;
    }
    if (act === 'export-json') {
      var dump = { app: '试剂出入库', team: S.team.name, exportedAt: new Date().toISOString(), reagents: S.reagents, batches: S.batches, txns: S.txns };
      download('试剂台账备份_' + today() + '.json', JSON.stringify(dump, null, 2), 'application/json');
      toast('已导出', 'ok');
      return;
    }
    if (act === 'export-xlsx') {
      try {
        if (!window.XLSXLite) throw new Error('Excel 组件未加载，请刷新页面后重试');
        if (!liveReagents().length && !liveTxns().length) { toast('还没有可导出的数据', 'err'); return; }
        var wbk = buildLedgerWorkbook();
        downloadBytes(wbk.name, wbk.bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        toast('已导出 Excel：库存台账 + 出入库流水', 'ok');
      } catch (e) { toast(U.msg(e), 'err'); }
      return;
    }
    if (act === 'export-csv') {
      var rows = [['日期', '类型', '试剂', '批号', '数量', '单位', '经办人', '用途', '课题', '备注']];
      filteredTxns().forEach(function (x) {
        rows.push([x.txn_date, x.kind === 'in' ? '入库' : x.kind === 'out' ? '出库' : '调整', x.reagent_name, x.lot_no, x.qty, x.unit, x.operator_name, x.purpose, x.project, x.note]);
      });
      var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','); }).join('\r\n');
      download('出入库流水_' + today() + '.csv', '\ufeff' + csv, 'text/csv');
      toast('已导出', 'ok');
      return;
    }
  });

  function download(name, content, type) {
    var blob = new Blob([content], { type: type + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* 输入框变化 → 更新草稿 */
  document.addEventListener('input', function (e) {
    var el = e.target;
    var bind = el.getAttribute && el.getAttribute('data-bind');
    if (bind && el.closest('[data-form="inbound"]') && UI.draftIn) {
      UI.draftIn[bind] = el.value;
      if (bind === 'reagentId') {
        UI.draftIn.newReagent = el.value === '__new';
        var picked = S.reagents.filter(function (x) { return x.id === el.value; })[0];
        if (picked) {
          UI.draftIn.unit = picked.unit || '瓶';
          UI.draftIn.location = picked.location || '';
        }
        render(true);
        return;
      }
      if (bind === 'unit') {
        var qu = document.getElementById('qty-u');
        if (qu) qu.textContent = el.value || '';
        var mu = document.getElementById('min-u');
        if (mu) mu.textContent = el.value || '';
      }
      return;
    }
    if (bind && el.closest('[data-form="outbound"]') && UI.draftOut) {
      if (bind === 'item') { UI.draftOut.items[el.getAttribute('data-batch')] = el.value; return; }
      UI.draftOut[bind] = el.value;
      if (bind === 'reagentId') { UI.draftOut.items = {}; render(true); }
      return;
    }
    var adj = el.getAttribute && el.getAttribute('data-adjust');
    if (adj) { UI.adjust[adj] = el.value; return; }
    if (el.id === 'q-inv') { UI.q = el.value; var z = document.getElementById('inv-zone'); if (z) z.innerHTML = inventoryTable(); return; }
    if (el.id === 'q-txn') { UI.txnQ = el.value; var z2 = document.getElementById('txn-zone'); if (z2) z2.innerHTML = txnTable(); return; }
    if (el.id === 'f-from') { UI.txnFrom = el.value; var z3 = document.getElementById('txn-zone'); if (z3) z3.innerHTML = txnTable(); return; }
    if (el.id === 'f-to') { UI.txnTo = el.value; var z4 = document.getElementById('txn-zone'); if (z4) z4.innerHTML = txnTable(); return; }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.id === 'f-cat') { UI.cat = el.value; var z = document.getElementById('inv-zone'); if (z) z.innerHTML = inventoryTable(); return; }
    if (el.id === 'f-st') { UI.st = el.value; var z2 = document.getElementById('inv-zone'); if (z2) z2.innerHTML = inventoryTable(); return; }
    if (el.id === 'f-kind') { UI.txnKind = el.value; var z3 = document.getElementById('txn-zone'); if (z3) z3.innerHTML = txnTable(); return; }
    var adj = el.getAttribute && el.getAttribute('data-adjust');
    if (adj) { render(); return; }
    /* select 的 data-bind 兼容：部分浏览器 change 才触发 */
    var b = el.getAttribute && el.getAttribute('data-bind');
    if (b === 'reagentId' && el.tagName === 'SELECT') {
      if (el.closest('[data-form="inbound"]') && UI.draftIn) {
        UI.draftIn.reagentId = el.value;
        UI.draftIn.newReagent = el.value === '__new';
        var picked = S.reagents.filter(function (x) { return x.id === el.value; })[0];
        if (picked) { UI.draftIn.unit = picked.unit || '瓶'; UI.draftIn.location = picked.location || ''; }
        render(true); return;
      }
      if (el.closest('[data-form="outbound"]') && UI.draftOut) {
        UI.draftOut.reagentId = el.value; UI.draftOut.items = {}; render(true); return;
      }
    }
    if (b === 'unit' && el.closest('[data-form="inbound"]') && UI.draftIn) {
      UI.draftIn.unit = el.value;
      var qu2 = document.getElementById('qty-u'); if (qu2) qu2.textContent = el.value || '';
      return;
    }
  });

  /* 表单提交 */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var name = form.getAttribute('data-form');
    if (!name) return;
    e.preventDefault();

    if (name === 'otp') {
      var info = UI.otpInfo;
      if (!info || !info.sent) { showErr('login-err', '请先获取验证码'); return; }
      var token = fieldVal(form, 'token').trim();
      if (!token) { showErr('login-err', '请输入验证码'); return; }
      var needPwd = !info.isExistingUser;
      var np1 = fieldVal(form, 'password');
      var np2 = fieldVal(form, 'password2');
      if (needPwd) {
        if (!np1 || np1.length < 6) { showErr('login-err', '请设置至少 6 位的登录密码'); return; }
        if (np1 !== np2) { showErr('login-err', '两次输入的密码不一致'); return; }
      }
      showErr('login-err', needPwd ? '创建账号中…' : '验证中…');
      var payload = {
        verificationId: info.verificationId, token: token,
        phone: info.phone, isExistingUser: info.isExistingUser
      };
      if (needPwd) payload.password = np1;
      Store.verifyOtp(payload).then(function () {
        UI.otpInfo = null;
        Store.saveLastPhone(info.phone);
        var chain = Promise.resolve();
        if (needPwd) {
          chain = Store.saveAccount(info.phone, np1, '', true).then(function () { Store.markCloudPwd(); });
        }
        return chain.then(function () {
          Store.unlock(30);
          UI.authMode = needPwd ? '' : 'newpwd';
          UI.resetInfo = needPwd ? null : { phone: info.phone };
          return Store.boot();
        });
      }).catch(function (err) { showErr('login-err', U.msg(err)); });
      return;
    }

    if (name === 'login-pwd') {
      var lu = Store.normPhone(fieldVal(form, 'phone'));
      var lp = fieldVal(form, 'password');
      if (!lu) { showErr('login-err', '请输入正确的 11 位手机号'); return; }
      if (!lp) { showErr('login-err', '请输入密码'); return; }
      UI.rememberMe = !!(document.getElementById('remember-me') && document.getElementById('remember-me').checked);
      showErr('login-err', '登录中…');
      var localMatch = !!(S.account && S.account.phone === lu);
      var localOk = localMatch ? Store.checkPassword(lu, lp) : Promise.resolve(false);
      var sessionGone = false;
      localOk.then(function (ok) {
        if (ok) {
          return Store.getSession().then(function (sess) {
            if (sess) return true;
            sessionGone = true;
            return Store.signInPassword(lu, lp).then(function () { return true; });
          });
        }
        return Store.signInPassword(lu, lp).then(function () { return true; });
      }).then(function (cloudOk) {
        Store.saveLastPhone(lu);
        if (cloudOk) Store.markCloudPwd();
        return Store.saveAccount(lu, lp, myName(), !!cloudOk || sessionGone).then(function () {
          Store.unlock(UI.rememberMe ? 30 : 0);
          UI.authMode = '';
          UI.otpInfo = null;
          render(true);
          Store.boot();
        });
      }).catch(function (err) {
        var m = U.msg(err) || '';
        if (localMatch && sessionGone) {
          showErr('login-err', '这台设备的登录凭证已过期，点「首次使用」收一次验证码就能恢复');
        } else if (/password|credential|密码|invalid/i.test(m)) {
          showErr('login-err', '手机号或密码不正确。换新手机首次登录请点「首次使用」收验证码。');
        } else {
          showErr('login-err', m || '登录失败，请稍后重试');
        }
      });
      return;
    }

    if (name === 'new-pwd') {
      var q1 = fieldVal(form, 'password');
      var q2 = fieldVal(form, 'password2');
      if (!q1 || q1.length < 6) { showErr('login-err', '密码至少 6 位'); return; }
      if (q1 !== q2) { showErr('login-err', '两次输入的密码不一致'); return; }
      showErr('login-err', '保存中…');
      var myPh = S.phone || (S.account && S.account.phone) || '';
      Store.saveAccount(myPh, q1, myName(), false)
        .then(function () { return Store.trySyncCloudPwd(q1); })
        .then(function (ok) {
          if (ok) Store.markCloudPwd();
          Store.unlock(30);
          UI.authMode = '';
          render(true);
          toast(ok ? '密码已设置，换手机也能登录' : '密码已设置在这台设备', 'ok');
        }).catch(function (err) { showErr('login-err', U.msg(err)); });
      return;
    }

    if (name === 'reset-pwd') {
      var r = UI.resetInfo || {};
      var rp = Store.normPhone(fieldVal(form, 'phone'));
      var rc = fieldVal(form, 'token').trim();
      var r1 = fieldVal(form, 'password');
      var r2 = fieldVal(form, 'password2');
      if (!rp) { showErr('login-err', '请输入正确的手机号'); return; }
      if (!r.vid) { showErr('login-err', '请先点「获取验证码」'); return; }
      if (!rc) { showErr('login-err', '请输入验证码'); return; }
      if (!r1 || r1.length < 6) { showErr('login-err', '密码至少 6 位'); return; }
      if (r1 !== r2) { showErr('login-err', '两次输入的密码不一致'); return; }
      showErr('login-err', '保存中…');
      Store.cloudPwdConfirm(r.vid, rc, r1, rp).then(function () {
        return Store.signInPassword(rp, r1).then(function () { return true; }, function () { return false; });
      }).then(function (cloudOk) {
        return Store.saveAccount(rp, r1, myName(), cloudOk).then(function () { return cloudOk; });
      }).then(function (cloudOk) {
        Store.unlock(30);
        UI.authMode = '';
        UI.resetInfo = null;
        render(true);
        if (S.session) Store.boot();
        toast(cloudOk ? '密码已重设，以后用手机号 + 密码登录' : '密码已保存，请用验证码登录', 'ok');
      }).catch(function (err) {
        showErr('login-err', U.msg(err) || '设置失败，请重试');
      });
      return;
    }

    if (name === 'join-team') {
      var jc = fieldVal(form, 'tcode').trim();
      if (!jc) { showErr('join-err', '请输入组口令'); return; }
      showErr('join-err', '提交中…');
      Store.joinTeam(jc).then(function (res) {
        if (res && res.joined) {
          closeModal();
          resetUiState();
          UI.view = 'settings';
          toast('已加入「' + (S.team ? S.team.name : '') + '」，已切过去', 'ok');
          render(true);
        } else {
          showErr('join-err', '');
          toast('申请已提交，等该组管理员审批', 'ok');
          render(true);
        }
      }).catch(function (err) { showErr('join-err', U.msg(err)); });
      return;
    }

    if (name === 'team') {
      var code = fieldVal(form, 'tcode').trim();
      var tname = fieldVal(form, 'tname').trim() || '科研小组';
      if (!code) { showErr('team-err', '请输入组口令'); return; }
      showErr('team-err', '处理中…');
      if (UI.teamMode === 'create') {
        Store.createTeam(code, tname).then(function () {
          UI.busy = false; render(); toast('小组已创建，你是管理员', 'ok');
        }).catch(function (err) { showErr('team-err', U.msg(err)); });
      } else {
        Store.requestJoin(code).then(function (res) {
          render(true);
          if (res && res.joined) toast('已进入小组', 'ok');
          else toast('申请已提交，等待管理员确认', 'ok');
        }).catch(function (err) { showErr('team-err', U.msg(err)); });
      }
      return;
    }

    if (name === 'inbound') {
      var d = UI.draftIn;
      var isNew = d.newReagent;
      var errEl = document.getElementById('in-err');
      if (errEl) errEl.textContent = '提交中…';
      var flow;
      if (isNew) {
        if (!d.name) { showErr('in-err', '请填写试剂名称'); return; }
        if (!String(d.unit).trim()) { showErr('in-err', '请填写或选择单位'); return; }
        flow = Store.saveReagent({
          name: d.name, category: d.category, spec: d.spec, cas: d.cas,
          unit: d.unit, min_stock: d.min_stock, location: d.location
        });
      } else {
        if (!d.reagentId) { showErr('in-err', '请选择试剂'); return; }
        var existing = S.reagents.filter(function (x) { return x.id === d.reagentId; })[0];
        /* 单位以本次入库为准，并同步到主档，避免同一试剂出现两种单位把总量算乱 */
        if (existing && String(d.unit).trim() && d.unit !== existing.unit) {
          flow = Store.saveReagent({
            id: existing.id, name: existing.name, category: existing.category, spec: existing.spec,
            cas: existing.cas, unit: d.unit, min_stock: existing.min_stock,
            location: existing.location, safety: existing.safety, note: existing.note
          });
        } else {
          flow = Promise.resolve(existing);
        }
      }
      flow.then(function (rg) {
        if (!rg) throw new Error('请选择试剂');
        return Store.addInbound({
          reagentId: rg.id, lot_no: d.lot_no, qty: d.qty, unit: d.unit || rg.unit,
          price: d.price, supplier: d.supplier, arrive_date: d.arrive_date,
          location: d.location || rg.location,
          operator_name: d.operator_name, note: d.note
        });
      }).then(function () {
        UI.draftIn = blankIn();
        render();
        toast('入库成功', 'ok');
      }).catch(function (err) { showErr('in-err', U.msg(err)); });
      return;
    }

    if (name === 'outbound') {
      var o = UI.draftOut;
      var items = Object.keys(o.items).filter(function (k) { return U.n(o.items[k]) > 0; })
        .map(function (k) { return { batchId: k, qty: o.items[k] }; });
      if (!o.reagentId) { showErr('out-err', '请选择试剂'); return; }
      if (!items.length) { showErr('out-err', '请填写领用数量'); return; }
      var el3 = document.getElementById('out-err');
      if (el3) el3.textContent = '提交中…';
      Store.addOutbound({
        reagentId: o.reagentId, items: items, operator_name: o.operator_name,
        purpose: o.purpose, project: o.project, txn_date: o.txn_date, note: o.note
      }).then(function () {
        UI.draftOut = blankOut();
        render();
        toast('出库成功', 'ok');
      }).catch(function (err) { showErr('out-err', U.msg(err)); });
      return;
    }
  });

  /* 渲染入口 */
  Store.on(function () { render(); });

  function start() {
    var root = document.createElement('div');
    root.id = 'root';
    var boot = document.getElementById('boot');
    if (boot) boot.remove();
    document.body.insertBefore(root, document.body.firstChild);
    /* 扫二维码进来的：?join=组口令 → 自动填好口令，登录后直接提交申请 */
    try {
      var u = new URL(location.href);
      var j = u.searchParams.get('join');
      if (j) { UI.qrCode = String(j).trim(); UI.teamMode = 'join'; }
    } catch (e) { }
    render();
    Store.boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
