import { create } from 'zustand';
import type { BoardMode, ThemePreset } from '@/lib/constants';
import type { TagStyle } from '@/lib/tag-styles';

export interface PlayerData {
  id: string;
  name: string;
  avatarUrl: string | null;
  tiers: Record<string, string>;       // { SHIELD: "HT1", CRYSTAL: "LT2", ... }
  overrideScores: Record<string, number | null>;  // { SHIELD: null, CRYSTAL: 99 }
  stats: Record<string, { kills: number; deaths: number; wins: number; matches: number }>;
  likes: number;
  emotionText: string | null;
  createdAt: string;
  updatedAt: string;
  tagStyle?: TagStyle | null;          // 玩家个性标签样式（管理员后台编辑，无则为默认）
  // AUTH V2.0 PHASE 3：管理员视角数据含 email（GET /api/v1/players 管理员分支
  // 既有能力）——后台「按邮箱搜索用户」（工单二）数据源；匿名视角不出（白名单剥离）
  email?: string | null;
}

export interface LogData {
  id: string;
  type: string;
  detail: string;
  scoreChange: string | null;
  adminKey: string | null;
  createdAt: string;
}

interface AppState {
  // Leaderboard
  players: PlayerData[];
  setPlayers: (players: PlayerData[]) => void;
  activeMode: BoardMode;
  setActiveMode: (mode: BoardMode) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  sortHighFirst: boolean;
  toggleSort: () => void;
  showEmptySlots: boolean;
  toggleEmptySlots: () => void;
  // Smart filters (M1)
  tierFilter: string | null;          // 'HT1' | 'LT1' | ... | null = all
  setTierFilter: (v: string | null) => void;
  statusFilter: 'all' | 'up' | 'down' | 'active';
  setStatusFilter: (v: 'all' | 'up' | 'down' | 'active') => void;
  filterSheetOpen: boolean;
  setFilterSheetOpen: (v: boolean) => void;
  // W2-T5: 时效切换
  period: 'all' | 'week' | 'season';
  setPeriod: (v: 'all' | 'week' | 'season') => void;
  // LIVE (M4) — increment a player's likes locally on socket signal
  liveLikePlayerId: string | null;
  triggerLiveLike: (playerId: string) => void;
  // V6: echo guard — likes WE initiated are already authoritative
  // (server count written by handleLike); the socket echo must not +1 again
  selfLikeAt: Record<string, number>;
  markSelfLike: (id: string) => void;

  // UI
  theme: ThemePreset;
  setTheme: (theme: ThemePreset) => void;
  announcementVisible: boolean;
  setAnnouncementVisible: (v: boolean) => void;
  tierDropdownOpen: boolean;
  setTierDropdownOpen: (v: boolean) => void;
  selectedPlayerId: string | null;
  setSelectedPlayerId: (id: string | null) => void;

  // Modals
  adminPanelOpen: boolean;
  setAdminPanelOpen: (v: boolean) => void;
  adminLoginOpen: boolean;
  setAdminLoginOpen: (v: boolean) => void;
  isAdmin: boolean;
  setIsAdmin: (v: boolean) => void;
  adminRole: string | null;
  setAdminRole: (v: string | null) => void;
  adminUsername: string | null;
  setAdminUsername: (v: string | null) => void;
  musicPlayerOpen: boolean;
  setMusicPlayerOpen: (v: boolean) => void;
  diyEditorOpen: boolean;
  setDiyEditorOpen: (v: boolean) => void;
  chatOpen: boolean;
  setChatOpen: (v: boolean) => void;
  aiAssistantOpen: boolean;
  setAiAssistantOpen: (v: boolean) => void;
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (v: boolean) => void;
  // V6 Widget Dock — mutual exclusion: exactly one widget open at a time
  activeWidget: 'chat' | 'ai' | 'music' | null;
  openWidget: (w: 'chat' | 'ai' | 'music' | null) => void;
  musicPlaying: boolean;
  setMusicPlaying: (v: boolean) => void;
  // SA-09 无障碍：全局「暂停所有动效」控件（WCAG 2.2 自动播放>5s 可暂停）
  pausedMotion: boolean;
  setPausedMotion: (v: boolean) => void;
  // SA-11 故障恢复：实时连接（socket.io）状态指示器
  liveConnected: boolean;
  setLiveConnected: (v: boolean) => void;
  chatUnread: number;
  bumpChatUnread: () => void;
  clearChatUnread: () => void;
  // V6 Resilience — data pipeline health + manual/auto retry
  loadError: string | null;
  setLoadError: (v: string | null) => void;
  dataVersion: number;
  retryDataLoad: () => void;
  apiHealth: 'ok' | 'fail' | 'checking';
  setApiHealth: (v: 'ok' | 'fail' | 'checking') => void;
  currentSeasonId: string | null;
  setCurrentSeasonId: (v: string | null) => void;
  editingPlayerId: string | null;
  setEditingPlayerId: (v: string | null) => void;

  // Config
  announcement: string;
  setAnnouncement: (v: string) => void;
  aboutText: string;
  setAboutText: (v: string) => void;
  tierExplanation: string;
  setTierExplanation: (v: string) => void;
  jiahaoExplanation: string;
  setJiahaoExplanation: (v: string) => void;
  musicUrls: string[];
  setMusicUrls: (urls: string[]) => void;
  // W1-T2: 参评门槛（从 Config.min_matches 读取，默认 5）
  minMatches: number;
  setMinMatches: (v: number) => void;

  // Logs
  logs: LogData[];
  setLogs: (logs: LogData[]) => void;

  // Loading
  loading: boolean;
  setLoading: (v: boolean) => void;

  // Custom bg
  customBg: string | null;
  setCustomBg: (v: string | null) => void;

  // Easter egg
  easterEggCount: number;
  incrementEasterEgg: () => void;

  // Current user identity (for self-row highlight)
  currentUserId: string | null;
  setCurrentUserId: (id: string | null) => void;

  // 玩家自助登录（方案 A）
  // AUTH V2.0 PHASE 3：mustChangePassword=true → PlayerAuthModal 渲染不可跳过的
  // 强制改密视图（临时密码首登后必须改密，工单三）
  player: { id: string; name: string; email: string; mustChangePassword?: boolean } | null;
  setPlayer: (p: { id: string; name: string; email: string; mustChangePassword?: boolean } | null) => void;
  playerAuthOpen: boolean;
  setPlayerAuthOpen: (v: boolean) => void;
  // 「我的」账户面板（整改：全部功能 + 注销系统）
  profileOpen: boolean;
  setProfileOpen: (v: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Leaderboard
  players: [],
  setPlayers: (players) => set({ players }),
  activeMode: 'TOTAL',
  setActiveMode: (activeMode) => set({ activeMode }),
  searchQuery: '',
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  sortHighFirst: true,
  toggleSort: () => set((s) => ({ sortHighFirst: !s.sortHighFirst })),
  showEmptySlots: false,
  toggleEmptySlots: () => set((s) => ({ showEmptySlots: !s.showEmptySlots })),
  tierFilter: null,
  setTierFilter: (tierFilter) => set({ tierFilter }),
  statusFilter: 'all',
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  filterSheetOpen: false,
  setFilterSheetOpen: (filterSheetOpen) => set({ filterSheetOpen }),
  // W2-T5: 时效切换（默认 all，URL query ?period= 初始化时覆盖）
  period: 'all',
  setPeriod: (period) => set({ period }),
  liveLikePlayerId: null,
  triggerLiveLike: (playerId) => set((s) => {
    // V6: ignore the socket echo of our own like — handleLike already
    // wrote the authoritative server count; a second +1 would double-count
    if (s.selfLikeAt[playerId] && Date.now() - s.selfLikeAt[playerId] < 10000) {
      return { liveLikePlayerId: playerId };
    }
    // Optimistic local increment + set the flag for UI pulse
    const players = s.players.map(p => p.id === playerId ? { ...p, likes: (p.likes || 0) + 1 } : p);
    return { players, liveLikePlayerId: playerId };
  }),
  selfLikeAt: {},
  markSelfLike: (id) => set((s) => ({ selfLikeAt: { ...s.selfLikeAt, [id]: Date.now() } })),

  // UI
  theme: 'aurora',
  setTheme: (theme) => set({ theme }),
  announcementVisible: true,
  setAnnouncementVisible: (announcementVisible) => set({ announcementVisible }),
  tierDropdownOpen: false,
  setTierDropdownOpen: (tierDropdownOpen) => set({ tierDropdownOpen }),
  selectedPlayerId: null,
  setSelectedPlayerId: (selectedPlayerId) => set({ selectedPlayerId }),

  // Modals
  adminPanelOpen: false,
  setAdminPanelOpen: (adminPanelOpen) => set({ adminPanelOpen }),
  adminLoginOpen: false,
  setAdminLoginOpen: (adminLoginOpen) => set({ adminLoginOpen }),
  isAdmin: false,
  setIsAdmin: (isAdmin) => set({ isAdmin }),
  adminRole: null,
  setAdminRole: (adminRole) => set({ adminRole }),
  adminUsername: null,
  setAdminUsername: (adminUsername) => set({ adminUsername }),
  musicPlayerOpen: false,
  setMusicPlayerOpen: (musicPlayerOpen) => set({ musicPlayerOpen }),
  diyEditorOpen: false,
  setDiyEditorOpen: (diyEditorOpen) => set({ diyEditorOpen }),
  chatOpen: false,
  setChatOpen: (chatOpen) => set({ chatOpen }),
  aiAssistantOpen: false,
  setAiAssistantOpen: (aiAssistantOpen) => set({ aiAssistantOpen }),
  commandPaletteOpen: false,
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  // V6 Widget Dock — single source of truth; opening one widget closes the others
  activeWidget: null,
  openWidget: (w) => set((s) => ({
    activeWidget: w,
    chatOpen: w === 'chat',
    aiAssistantOpen: w === 'ai',
    musicPlayerOpen: w === 'music',
    chatUnread: w === 'chat' ? 0 : s.chatUnread,
  })),
  musicPlaying: false,
  setMusicPlaying: (musicPlaying) => set({ musicPlaying }),
  // SA-09/SA-11：默认 false——未暂停 + 未连接
  pausedMotion: false,
  setPausedMotion: (pausedMotion) => set({ pausedMotion }),
  liveConnected: false,
  setLiveConnected: (liveConnected) => set({ liveConnected }),
  chatUnread: 0,
  bumpChatUnread: () => set((s) => ({ chatUnread: s.chatUnread + 1 })),
  clearChatUnread: () => set({ chatUnread: 0 }),
  // V6 Resilience
  loadError: null,
  setLoadError: (loadError) => set({ loadError }),
  dataVersion: 0,
  retryDataLoad: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
  apiHealth: 'checking',
  setApiHealth: (apiHealth) => set({ apiHealth }),
  currentSeasonId: null,
  setCurrentSeasonId: (currentSeasonId) => set({ currentSeasonId }),
  editingPlayerId: null,
  setEditingPlayerId: (editingPlayerId) => set({ editingPlayerId }),

  // Config
  announcement: '',
  setAnnouncement: (announcement) => set({ announcement }),
  aboutText: '',
  setAboutText: (aboutText) => set({ aboutText }),
  tierExplanation: '',
  setTierExplanation: (tierExplanation) => set({ tierExplanation }),
  jiahaoExplanation: '',
  setJiahaoExplanation: (jiahaoExplanation) => set({ jiahaoExplanation }),
  musicUrls: ['', '', '', '', ''],
  setMusicUrls: (musicUrls) => set({ musicUrls }),
  // W1-T2: 参评门槛
  minMatches: 5,
  setMinMatches: (minMatches) => set({ minMatches }),

  // Logs
  logs: [],
  setLogs: (logs) => set({ logs }),

  // Loading
  loading: true,
  setLoading: (loading) => set({ loading }),

  // Custom bg
  customBg: null,
  setCustomBg: (customBg) => set({ customBg }),

  // Easter egg
  easterEggCount: 0,
  incrementEasterEgg: () => set((s) => ({ easterEggCount: s.easterEggCount + 1 })),

  // Current user identity
  currentUserId: null,
  setCurrentUserId: (currentUserId) => set({ currentUserId }),

  // 玩家自助登录
  player: null,
  setPlayer: (player) => set({ player, currentUserId: player?.id || null }),
  playerAuthOpen: false,
  setPlayerAuthOpen: (playerAuthOpen) => set({ playerAuthOpen }),
  profileOpen: false,
  setProfileOpen: (profileOpen) => set({ profileOpen }),
}));
