/**
 * メメントモリ GvG リアルタイムビューア
 * mentemori.icu の WebSocket API を利用してギルドバトルの情報をリアルタイムに取得・表示する
 */

// ===========================
// 定数定義
// ===========================

// ギルバト（ローカルGvG）の城名
const LOCAL_CASTLE_NAMES = [
  'ブラッセル', 'ウィスケルケー', 'モダーヴ', 'シメイ', 'グラベンスティン',
  'カンブル', 'クインティヌス', 'ランベール', 'サンジャック', 'ミヒャエル',
  'ナミュール', 'シャルルロア', 'アルゼット', 'エノー', 'ワーヴル',
  'モンス', 'クリストフ', 'コルトレイク', 'イーペル', 'サルヴァトール', 'バーフ'
];

// グラバト（グローバルGvG）の城名
const GLOBAL_CASTLE_NAMES = [
  'アイン', 'イエソド', 'マルクト', 'ケテル', 'テファレト',
  'クシェル', 'シトリ', 'トパズ', 'メラル', 'ペリド',
  'ファリア', 'ラピス', 'ラリマル', 'マリン', 'アメト',
  'ラベン', 'シルコン', 'オニキス', 'フロライト', 'ガネット', 'ルラ'
];

// 城タイプ（1=寺院, 2-5=城, 6-21=教会）
const getCastleType = (id) => {
  if (id === 1) return '寺院';
  if (id <= 5) return '城';
  return '教会';
};

// サーバーIDオフセット
const SERVER_OFFSETS = { jp: 1000, kr: 2000, as: 3000, na: 4000, eu: 5000, gl: 6000 };

// GvG城の戦闘状態
const GVG_STATE = {
  0: '防衛',       // neutral / peaceful defense
  1: '侵攻',       // active battle (attacker is attacking)
  2: '陥落',       // fallen (attacker won)
  3: '奪還戦',     // recapture battle
};

// ===========================
// アプリケーション状態
// ===========================
const state = {
  mode: 'local',           // 'local' | 'global'
  server: 'jp',
  worldId: null,
  groupId: 0,
  classId: 3,
  blockId: 0,
  ws: null,
  currentSubscription: null,

  // 拠点フィルター状態
  filter: {
    guildId: 'all',        // 'all' | GuildId(数値)
    role: 'any',           // 'any' | 'defender' | 'attacker'
    status: 'all',         // 'all' | 'battle' | 'peace'
  },

  // リアルタイムデータ
  guilds: {},              // guildId -> guildName
  players: {},             // guildId -> [{PlayerId, GuildId, PlayerName}, ...]
  castles: [],             // castleId-1 -> castle state
  deployments: {},         // playerId -> {CharacterId, CastleId, DeployCount}
  loginTimes: {},          // playerId -> LastLoginTime
  deployLog: [],           // 最新の配置ログ

  // ワールド/グループ情報
  worlds: [],
  wgroups: [],
};

// ===========================
// DOM要素取得
// ===========================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ===========================
// ユーティリティ関数
// ===========================

/** HTMLエスケープ */
const escapeHtml = (str) => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

/** 時刻フォーマット */
const formatTime = (date) => {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

/** ストリームIDをエンコード */
const encodeStreamId = (worldId, groupId, classId, blockId, castleId = 0) => {
  return (worldId << 19) | (classId << 16) | (groupId << 8) | (blockId << 5) | castleId;
};

/** ストリームIDをデコード */
const decodeStreamId = (packed) => ({
  WorldId: packed >>> 19,
  GroupId: (packed >>> 8) & 0xFF,
  Class: (packed >>> 16) & 0x7,
  Block: (packed >>> 5) & 0x7,
  CastleId: packed & 0x1F,
});

/** 現在のサブスクリプションとストリームIDが一致するか */
const matchesSubscription = (streamId) => {
  const sub = state.currentSubscription;
  if (!sub) return false;

  if (sub.GroupId === 0 && sub.Class === 0 && sub.Block === 0) {
    // ギルバト: WorldId一致で判定
    return streamId.WorldId === sub.WorldId;
  }
  if (streamId.GroupId === 0 && streamId.Class === 0 && streamId.Block === 0) {
    return streamId.WorldId === sub.WorldId;
  }
  // グラバト: GroupId, Class, Block 一致で判定
  return streamId.GroupId === sub.GroupId &&
         streamId.Class === sub.Class &&
         streamId.Block === sub.Block;
};

// ===========================
// バイナリパーサー
// ===========================

/** ギルド情報パース (CastleId=0) */
const parseGuild = (dv, offset) => {
  const guildIdRaw = dv.getUint32(offset, true);
  const nameLen = dv.getUint8(offset + 4, true);
  const nameBytes = new Uint8Array(dv.buffer, offset + 5, nameLen);
  const guildName = new TextDecoder('utf-8').decode(nameBytes);
  return {
    value: { GuildId: guildIdRaw * 1000, GuildName: guildName },
    offset: offset + 5 + nameLen,
  };
};

/** 城の戦闘状態パース (CastleId=1-21) */
const parseCastle = (dv, offset, worldId) => ({
  value: {
    GuildId: dv.getUint32(offset, true) * 1000,
    AttackerGuildId: dv.getUint32(offset + 4, true) * 1000,
    UtcFallenTimeStamp: dv.getUint32(offset + 8, true) * 1000,
    DefensePartyCount: dv.getUint16(offset + 12, true),
    AttackPartyCount: dv.getUint16(offset + 14, true),
    GvgCastleState: dv.getUint8(offset + 16, true),
    LastWinPartyKnockOutCount: dv.getUint16(offset + 18, true),
  },
  offset: offset + 20,
});

/** プレイヤー情報パース (CastleId=31) */
const parsePlayer = (dv, offset, worldId) => {
  const playerIdRaw = dv.getUint32(offset, true);
  const guildIdRaw = dv.getUint32(offset + 4, true);
  const nameLen = dv.getUint8(offset + 8, true);
  const nameBytes = new Uint8Array(dv.buffer, offset + 16, nameLen);
  const playerName = new TextDecoder('utf-8').decode(nameBytes);
  const worldMod = worldId % 1000;
  return {
    value: {
      PlayerId: playerIdRaw * 1000 + worldMod,
      GuildId: guildIdRaw * 1000 + worldMod,
      PlayerName: playerName,
    },
    offset: offset + 16 + nameLen,
  };
};

/** キャラ配置パース (CastleId=29,30) */
const parseDeploy = (dv, offset, worldId) => {
  const playerIdRaw = dv.getUint32(offset, true);
  const characterId = dv.getUint16(offset + 4, true);
  const packed = dv.getUint16(offset + 6, true);
  const worldMod = worldId % 1000;
  return {
    value: {
      PlayerId: playerIdRaw * 1000 + worldMod,
      CharacterId: characterId,
      CastleId: packed & 0x1F,
      DeployCount: (packed >> 5) & 0x7,
    },
    offset: offset + 8,
  };
};

/** ログイン時刻パース (CastleId=28) */
const parseLoginTime = (dv, offset, worldId) => ({
  value: {
    PlayerId: dv.getUint32(offset, true) * 1000 + (worldId % 1000),
    LastLoginTime: dv.getUint32(offset + 4, true),
  },
  offset: offset + 16,
});

// ===========================
// WebSocket接続管理
// ===========================

/** 接続状態を更新 */
const updateConnectionStatus = (status) => {
  const el = $('#connection-status');
  el.className = 'connection-status ' + status;
  const textEl = el.querySelector('.status-text');
  switch (status) {
    case 'connected':
      textEl.textContent = '接続中';
      break;
    case 'connecting':
      textEl.textContent = '接続中...';
      break;
    default:
      textEl.textContent = '未接続';
  }
};

/** エラー表示 */
const showError = (msg) => {
  const bar = $('#error-bar');
  const text = $('#error-text');
  text.textContent = msg;
  bar.classList.remove('hidden');
};

/** エラー非表示 */
const hideError = () => {
  $('#error-bar').classList.add('hidden');
};

/** WebSocketに購読メッセージを送信 */
const sendSubscription = (sub) => {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  const packed = encodeStreamId(sub.WorldId, sub.GroupId, sub.Class, sub.Block);
  dv.setUint32(0, packed, true);
  state.ws.send(buf);
};

/** WebSocket接続 */
const connectWebSocket = () => {
  // 既存の接続を閉じる
  if (state.ws) {
    state.ws._intentionalClose = true;
    state.ws.close();
    state.ws = null;
  }

  updateConnectionStatus('connecting');
  hideError();

  const ws = new WebSocket('wss://api.mentemori.icu/gvg');
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.addEventListener('open', () => {
    updateConnectionStatus('connected');
    hideError();

    // 現在のサブスクリプションを送信
    if (state.currentSubscription) {
      sendSubscription(state.currentSubscription);
    }
  });

  ws.addEventListener('message', (event) => {
    const dv = new DataView(event.data);
    let offset = 0;

    while (offset < dv.byteLength) {
      // ストリームIDを読み取り
      const packed = dv.getUint32(offset, true);
      const streamId = decodeStreamId(packed);
      offset += 4;

      // サブスクリプションの一致チェック
      const matches = matchesSubscription(streamId);

      if (streamId.CastleId === 0) {
        // ギルド情報
        const result = parseGuild(dv, offset);
        offset = result.offset;
        if (!matches) continue;

        const guild = result.value;
        if (guild.GuildId === 0) {
          state.guilds = {};
        } else {
          state.guilds[guild.GuildId] = guild.GuildName;
        }
        renderGuilds();
        updateSummary();

      } else if (streamId.CastleId === 31) {
        // プレイヤー情報
        const result = parsePlayer(dv, offset, streamId.WorldId);
        offset = result.offset;
        if (!matches) continue;

        const player = result.value;
        if (player.PlayerId === 0) {
          state.players = {};
        } else {
          if (!state.players[player.GuildId]) {
            state.players[player.GuildId] = [];
          }
          state.players[player.GuildId].push(player);
        }
        renderGuilds();
        updateSummary();

      } else if (streamId.CastleId === 30 || streamId.CastleId === 29) {
        // キャラ配置
        const result = parseDeploy(dv, offset, streamId.WorldId);
        offset = result.offset;
        if (!matches) continue;

        const deploy = result.value;
        if (!state.deployments[deploy.PlayerId]) {
          state.deployments[deploy.PlayerId] = {};
        }
        if (deploy.DeployCount === 0) {
          delete state.deployments[deploy.PlayerId][deploy.CastleId];
        } else {
          state.deployments[deploy.PlayerId][deploy.CastleId] = deploy.DeployCount;
        }

        // 配置ログに追加
        const playerName = findPlayerName(deploy.PlayerId);
        const castleNames = state.mode === 'local' ? LOCAL_CASTLE_NAMES : GLOBAL_CASTLE_NAMES;
        const castleName = castleNames[deploy.CastleId - 1] || `城${deploy.CastleId}`;

        state.deployLog.unshift({
          time: new Date(),
          playerName: playerName || `ID:${deploy.PlayerId}`,
          castleName,
          deployCount: deploy.DeployCount,
        });

        // ログは最大100件
        if (state.deployLog.length > 100) state.deployLog.length = 100;
        renderDeployLog();
        renderGuilds();

      } else if (streamId.CastleId === 28) {
        // ログイン時刻
        const result = parseLoginTime(dv, offset, streamId.WorldId);
        offset = result.offset;
        if (!matches) continue;

        const login = result.value;
        if (login.PlayerId === 0) {
          state.loginTimes = {};
        } else {
          state.loginTimes[login.PlayerId] = login;
        }

      } else {
        // 城の戦闘状態 (CastleId=1-21)
        const result = parseCastle(dv, offset, streamId.WorldId);
        offset = result.offset;
        if (!matches) continue;

        const castle = result.value;
        castle.StreamId = streamId;
        state.castles[streamId.CastleId - 1] = castle;
        renderCastles();
        updateSummary();
      }
    }
  });

  ws.addEventListener('error', () => {
    showError('WebSocket接続エラー');
    updateConnectionStatus('disconnected');
  });

  ws.addEventListener('close', () => {
    updateConnectionStatus('disconnected');
    if (!ws._intentionalClose) {
      showError('接続が切断されました。5秒後に再接続します...');
      setTimeout(connectWebSocket, 5000);
    }
  });
};

// ===========================
// データ検索ヘルパー
// ===========================

/** PlayerIDからプレイヤー名を検索 */
const findPlayerName = (playerId) => {
  for (const guildId in state.players) {
    const members = state.players[guildId];
    for (const member of members) {
      if (member.PlayerId === playerId) return member.PlayerName;
    }
  }
  return null;
};

// ===========================
// 描画関数
// ===========================

/** サマリーカードを更新 */
const updateSummary = () => {
  // 城数
  const activeCastles = state.castles.filter(c => c).length;
  $('#total-castles').textContent = activeCastles;

  // ギルド数
  const guildCount = Object.keys(state.guilds).length;
  $('#total-guilds').textContent = guildCount;

  // プレイヤー数
  let playerCount = 0;
  for (const guildId in state.players) {
    playerCount += state.players[guildId].length;
  }
  $('#total-players').textContent = playerCount;

  // 戦闘中の城
  const battleCount = state.castles.filter(c => c && (c.GvgCastleState % 2 === 1)).length;
  $('#active-battles').textContent = battleCount;
};

/** ギルドフィルター選択肢を動的に更新 */
const updateGuildFilterOptions = () => {
  const select = $('#filter-guild');
  if (!select) return;

  const currentSelected = select.value || 'all';

  // 参加ギルド一覧を収集（state.guilds + state.castles に出現するギルド）
  const guildMap = new Map();

  for (const [id, name] of Object.entries(state.guilds)) {
    guildMap.set(Number(id), name);
  }

  for (const castle of state.castles) {
    if (castle) {
      if (castle.GuildId && !guildMap.has(castle.GuildId)) {
        guildMap.set(castle.GuildId, state.guilds[castle.GuildId] || `Guild ${castle.GuildId}`);
      }
      if (castle.AttackerGuildId && !guildMap.has(castle.AttackerGuildId)) {
        guildMap.set(castle.AttackerGuildId, state.guilds[castle.AttackerGuildId] || `Guild ${castle.AttackerGuildId}`);
      }
    }
  }

  let html = '<option value="all">すべてのギルド</option>';
  for (const [id, name] of guildMap.entries()) {
    html += `<option value="${id}">${escapeHtml(name)}</option>`;
  }

  select.innerHTML = html;

  // 以前の選択を復元（存在する場合）
  if ([...select.options].some(opt => opt.value === currentSelected)) {
    select.value = currentSelected;
  } else {
    select.value = 'all';
    state.filter.guildId = 'all';
  }
};

/** 城がフィルター条件に一致するか判定 */
const matchesFilter = (castle) => {
  const { guildId, role, status } = state.filter;

  // 1. 状態フィルター（侵攻 / 防衛）
  if (status === 'attack') {
    // 侵攻：攻撃中・戦闘中・または攻撃パーティが存在する拠点
    if (!castle || (castle.GvgCastleState % 2 !== 1 && castle.AttackPartyCount === 0 && !castle.AttackerGuildId)) return false;
  } else if (status === 'defense') {
    // 防衛：攻撃を受けておらず防衛のみの平和な拠点
    if (castle && (castle.GvgCastleState % 2 === 1 || castle.AttackPartyCount > 0 || castle.AttackerGuildId)) return false;
  }

  // 2. ギルドフィルター
  if (guildId !== 'all') {
    const targetGuildId = Number(guildId);
    if (!castle) return false;

    const isDefender = castle.GuildId === targetGuildId;
    const isAttacker = castle.AttackerGuildId === targetGuildId;

    if (role === 'defender' && !isDefender) return false;
    if (role === 'attacker' && !isAttacker) return false;
    if (role === 'any' && !isDefender && !isAttacker) return false;
  }

  return true;
};

/** 城一覧を描画 */
const renderCastles = () => {
  const container = $('#castles-grid');
  const castleNames = state.mode === 'local' ? LOCAL_CASTLE_NAMES : GLOBAL_CASTLE_NAMES;

  // ギルドフィルター選択肢を更新
  updateGuildFilterOptions();

  let html = '';
  let visibleCount = 0;

  for (let i = 0; i < 21; i++) {
    const castle = state.castles[i];
    
    // フィルター判定
    if (!matchesFilter(castle)) continue;

    visibleCount++;
    const name = castleNames[i] || `城${i + 1}`;
    const type = getCastleType(i + 1);

    if (!castle) {
      html += `
        <div class="castle-card">
          <div class="castle-header">
            <span class="castle-name">${escapeHtml(name)}</span>
            <span class="castle-type">${type}</span>
          </div>
          <div class="castle-guild">
            <span class="guild-label">所有:</span>
            <span>—</span>
          </div>
        </div>`;
      continue;
    }

    const isBattle = castle.GvgCastleState % 2 === 1;
    const stateText = GVG_STATE[castle.GvgCastleState] || `状態${castle.GvgCastleState}`;
    const ownerName = state.guilds[castle.GuildId] || `Guild${castle.GuildId}`;
    const attackerName = castle.AttackerGuildId ? (state.guilds[castle.AttackerGuildId] || `Guild${castle.AttackerGuildId}`) : '';

    const cardClass = isBattle ? 'battle' : 'neutral';

    html += `
      <div class="castle-card ${cardClass}">
        <div class="castle-header">
          <span class="castle-name">${escapeHtml(name)}</span>
          <span class="castle-type">${type} / ${stateText}</span>
        </div>
        <div class="castle-guild">
          <span class="guild-label">🛡️ 防衛:</span>
          <span>${escapeHtml(ownerName)}</span>
        </div>
        ${isBattle && attackerName ? `
        <div class="castle-guild" style="color: var(--danger);">
          <span class="guild-label">⚔️ 攻撃:</span>
          <span>${escapeHtml(attackerName)}</span>
        </div>` : ''}
        <div class="castle-stats">
          <span class="castle-stat defense">
            <span class="stat-icon">🛡️</span>
            ${castle.DefensePartyCount}
          </span>
          <span class="castle-stat offense">
            <span class="stat-icon">⚔️</span>
            ${castle.AttackPartyCount}
          </span>
          ${castle.LastWinPartyKnockOutCount >= 10 ? `
          <span class="ko-badge">KO: ${castle.LastWinPartyKnockOutCount}</span>
          ` : ''}
        </div>
      </div>`;
  }

  if (visibleCount === 0) {
    html = '<div class="empty-castles-message">🔍 該当する拠点（城）はありません</div>';
  }

  container.innerHTML = html;
};

/** プレイヤーの使用スタミナ（合計配置数）および内訳を取得 */
const getPlayerStaminaInfo = (playerId) => {
  const userDeploys = state.deployments[playerId];
  if (!userDeploys) return { totalStamina: 0, details: [] };

  const castleNames = state.mode === 'local' ? LOCAL_CASTLE_NAMES : GLOBAL_CASTLE_NAMES;
  let totalStamina = 0;
  const details = [];

  for (const [castleIdStr, count] of Object.entries(userDeploys)) {
    const castleId = Number(castleIdStr);
    if (count > 0) {
      totalStamina += count;
      const cName = castleNames[castleId - 1] || `城${castleId}`;
      details.push(`📍${cName} (${count}体)`);
    }
  }

  return { totalStamina, details };
};

/** ギルド・参加者一覧を描画 */
const renderGuilds = () => {
  const container = $('#guilds-container');

  // ギルドIDを収集（guilds辞書 + players辞書の両方から）
  const allGuildIds = new Set([
    ...Object.keys(state.guilds),
    ...Object.keys(state.players),
  ]);

  if (allGuildIds.size === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 30px;">データを待機中...</p>';
    return;
  }

  let html = '';
  for (const guildId of allGuildIds) {
    // 拠点フィルターで特定のギルドが選ばれている場合、それ以外のギルドは非表示
    if (state.filter.guildId !== 'all' && Number(state.filter.guildId) !== Number(guildId)) {
      continue;
    }

    const guildName = state.guilds[guildId] || `Guild ${guildId}`;
    const members = state.players[guildId] || [];

    // ギルド全体の総使用スタミナ数
    let guildTotalStamina = 0;

    let membersHtml = '';
    if (members.length === 0) {
      membersHtml = '<div class="member-item" style="color: var(--text-muted);">メンバー情報なし</div>';
    } else {
      for (const member of members) {
        const { totalStamina, details } = getPlayerStaminaInfo(member.PlayerId);
        guildTotalStamina += totalStamina;

        const staminaBadge = totalStamina > 0
          ? `<span class="stamina-badge">⚡ ${totalStamina} スタミナ</span>`
          : `<span class="stamina-badge empty">未配置</span>`;

        const detailsText = details.length > 0 ? details.join(' ') : '';

        membersHtml += `
          <div class="member-item">
            <div class="member-main">
              <span class="member-name">${escapeHtml(member.PlayerName)}</span>
              ${staminaBadge}
            </div>
            ${detailsText ? `<div class="member-deploy">${detailsText}</div>` : ''}
          </div>`;
      }
    }

    html += `
      <div class="guild-card">
        <div class="guild-card-header">
          <div>
            <span class="guild-name">${escapeHtml(guildName)}</span>
            <span class="guild-stamina-total">⚡ 総スタミナ: ${guildTotalStamina}</span>
          </div>
          <span class="guild-member-count">${members.length}人</span>
        </div>
        <div class="guild-members">
          ${membersHtml}
        </div>
      </div>`;
  }

  if (!html) {
    html = '<p style="color: var(--text-muted); text-align: center; padding: 30px;">該当するギルドデータはありません</p>';
  }

  container.innerHTML = html;
};

/** 配置ログを描画 */
const renderDeployLog = () => {
  const container = $('#deploy-log');

  if (state.deployLog.length === 0) {
    container.innerHTML = '<div class="log-empty">配置ログはまだありません</div>';
    return;
  }

  let html = '';
  for (const entry of state.deployLog.slice(0, 50)) {
    html += `
      <div class="log-entry">
        <span class="log-time">${formatTime(entry.time)}</span>
        <span class="log-player">${escapeHtml(entry.playerName)}</span>
        <span class="log-action">→</span>
        <span class="log-castle">${escapeHtml(entry.castleName)}</span>
        <span class="log-action">(${entry.deployCount}体配置)</span>
      </div>`;
  }

  container.innerHTML = html;
};

// ===========================
// データリセット & サブスクリプション変更
// ===========================

/** データをリセット */
const resetData = () => {
  state.guilds = {};
  state.players = {};
  state.castles = [];
  state.deployments = {};
  state.loginTimes = {};
  state.deployLog = [];
};

/** 新しいサブスクリプションを開始 */
const subscribe = () => {
  // 古いサブスクリプションを解除
  const oldSub = state.currentSubscription;

  // 新しいサブスクリプション作成
  let newSub;
  if (state.mode === 'local') {
    if (!state.worldId) return;
    newSub = {
      WorldId: +state.worldId,
      GroupId: 0,
      Class: 0,
      Block: 0,
    };
  } else {
    newSub = {
      WorldId: 0,
      GroupId: +state.groupId,
      Class: +state.classId,
      Block: +state.blockId,
    };
  }

  // データリセット
  resetData();
  renderCastles();
  renderGuilds();
  renderDeployLog();
  updateSummary();

  // サブスクリプション更新
  state.currentSubscription = newSub;

  // WebSocketで送信
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (oldSub) sendSubscription(oldSub); // 旧サブスクリプション解除（再送で解除）
    sendSubscription(newSub);
  }
};

// ===========================
// ワールド/グループ情報の取得
// ===========================

/** ワールド一覧を取得 */
const fetchWorlds = async () => {
  try {
    const res = await fetch('https://api.mentemori.icu/worlds');
    const data = await res.json();
    state.worlds = data.data || [];
    state.worlds.sort((a, b) => a.world_id - b.world_id);
    renderWorldButtons();
  } catch (e) {
    showError('ワールド一覧の取得に失敗しました: ' + e.message);
  }
};

/** グループ一覧を取得 */
const fetchGroups = async () => {
  try {
    const res = await fetch('https://api.mentemori.icu/wgroups');
    const data = await res.json();
    state.wgroups = data.data || [];
    state.wgroups.sort((a, b) => a.group_id - b.group_id);
    renderGroupButtons();
  } catch (e) {
    showError('グループ一覧の取得に失敗しました: ' + e.message);
  }
};

/** ワールドボタンを描画 */
const renderWorldButtons = () => {
  const container = $('#world-select');
  const serverPrefix = SERVER_OFFSETS[state.server];

  // 現在のサーバーに属する、かつ ローカルGvG対応のワールドのみ表示
  const filteredWorlds = state.worlds.filter(w =>
    w.server === state.server && (state.mode === 'local' ? w.localgvg : w.ranking)
  );

  let html = '';
  for (const w of filteredWorlds) {
    const worldNum = w.world_id % 1000;
    html += `<button class="select-btn" data-world="${w.world_id}">W${worldNum}</button>`;
  }

  container.innerHTML = html || '<span style="color: var(--text-muted); padding: 8px;">ワールドなし</span>';

  // イベント設定
  container.querySelectorAll('.select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.worldId = btn.dataset.world;
      subscribe();
    });
  });

  // 最初のワールドを自動選択
  const first = container.querySelector('.select-btn');
  if (first) {
    first.classList.add('active');
    state.worldId = first.dataset.world;
    subscribe();
  }
};

/** グループボタンを描画 */
const renderGroupButtons = () => {
  const container = $('#group-select');
  const serverPrefix = SERVER_OFFSETS[state.server];

  // 現在のサーバーに属するグループのみ表示
  const filtered = state.wgroups.filter(g =>
    g.globalgvg &&
    g.worlds.some(w => Math.floor(w / 1000) * 1000 === serverPrefix)
  );

  let html = '';
  for (const g of filtered) {
    const worldsStr = g.worlds.map(w => 'W' + (w % 1000)).join(', ');
    html += `<button class="select-btn" data-group="${g.group_id}">G${g.group_id} (${worldsStr})</button>`;
  }

  container.innerHTML = html || '<span style="color: var(--text-muted); padding: 8px;">グループなし</span>';

  // イベント設定
  container.querySelectorAll('.select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.groupId = +btn.dataset.group;
      subscribe();
    });
  });

  // 最初のグループを自動選択
  const first = container.querySelector('.select-btn');
  if (first) {
    first.classList.add('active');
    state.groupId = +first.dataset.group;
    subscribe();
  }
};

// ===========================
// UIイベント設定
// ===========================

const setupUI = () => {
  // モード切替
  $$('#mode-toggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#mode-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;

      // 表示切替
      if (state.mode === 'local') {
        $('#world-control').classList.remove('hidden');
        $('#group-control').classList.add('hidden');
        $('#class-control').classList.add('hidden');
        $('#block-control').classList.add('hidden');
        renderWorldButtons();
      } else {
        $('#world-control').classList.add('hidden');
        $('#group-control').classList.remove('hidden');
        $('#class-control').classList.remove('hidden');
        $('#block-control').classList.remove('hidden');
        renderGroupButtons();
      }
    });
  });

  // サーバー選択
  $$('#server-select .select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#server-select .select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.server = btn.dataset.server;

      if (state.mode === 'local') {
        renderWorldButtons();
      } else {
        renderGroupButtons();
      }
    });
  });

  // クラス選択（グラバト）
  $$('#class-select .select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#class-select .select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.classId = +btn.dataset.class;
      subscribe();
    });
  });

  // ブロック選択（グラバト）
  $$('#block-select .select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#block-select .select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.blockId = +btn.dataset.block;
      subscribe();
    });
  });

  // 拠点フィルター
  $('#filter-guild')?.addEventListener('change', (e) => {
    state.filter.guildId = e.target.value;
    renderCastles();
  });

  $('#filter-role')?.addEventListener('change', (e) => {
    state.filter.role = e.target.value;
    renderCastles();
  });

  $('#filter-status')?.addEventListener('change', (e) => {
    state.filter.status = e.target.value;
    renderCastles();
  });

  $('#filter-reset-btn')?.addEventListener('click', () => {
    state.filter.guildId = 'all';
    state.filter.role = 'any';
    state.filter.status = 'all';

    if ($('#filter-guild')) $('#filter-guild').value = 'all';
    if ($('#filter-role')) $('#filter-role').value = 'any';
    if ($('#filter-status')) $('#filter-status').value = 'all';

    renderCastles();
  });
};

// ===========================
// 初期化
// ===========================

const init = async () => {
  setupUI();

  // 初期描画
  renderCastles();
  renderGuilds();
  renderDeployLog();
  updateSummary();

  // データ取得
  await Promise.all([fetchWorlds(), fetchGroups()]);

  // WebSocket接続
  connectWebSocket();
};

// アプリ起動
document.addEventListener('DOMContentLoaded', init);
