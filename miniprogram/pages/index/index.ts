import { createRecorderSession, normalizeBpm, prepareAudioContext } from '../../utils/audio-session'

type TabKey = 'sing' | 'instrument' | 'theory' | 'practice' | 'me'

let metronomeTimer: ReturnType<typeof setTimeout> | null = null
let countInTimer: ReturnType<typeof setInterval> | null = null
let rhythmTimers: Array<ReturnType<typeof setTimeout>> = []
let metronomeContext: any = null
let metronomeStartToken = 0
let recorderSession: ReturnType<typeof createRecorderSession> | null = null

const METRONOME_RECORD_MAX_DURATION_MS = 180000
const METRONOME_SAMPLE_RATE = 22050
const METRONOME_CLICK_FULL_DURATION_MS = 72
const METRONOME_CLICK_SHORT_DURATION_MS = 28
const METRONOME_TONE_CONFIG: Record<string, { type: 'sine' | 'square' | 'triangle'; high: number; low: number }> = {
  classic: { type: 'sine', high: 1120, low: 760 },
  wood: { type: 'square', high: 880, low: 620 },
  soft: { type: 'triangle', high: 720, low: 520 },
}
const RHYTHM_SUBDIVISIONS: Record<string, number> = {
  off: 1,
  eighth: 2,
  triplet: 3,
  sixteenth: 4,
}
let metronomeClickPaths: Record<string, string> | null = null
let metronomeClickPreparation: Promise<Record<string, string>> | null = null
let metronomeSoundMode: 'file' | 'webaudio' | null = null
let innerAudioConfigured = false
const metronomeRecordingState = {
  recorder: null as any,
  requested: false,
  active: false,
  starting: false,
  discarded: false,
  startedAt: 0,
  timer: 0 as any,
  requestId: 0,
  path: '',
  player: null as WechatMiniprogram.InnerAudioContext | null,
}

function createMetronomeClickWav(tone: keyof typeof METRONOME_TONE_CONFIG, accent: boolean, durationMs: number) {
  const definition = METRONOME_TONE_CONFIG[tone]
  const sampleCount = Math.round(METRONOME_SAMPLE_RATE * durationMs / 1000)
  const wav = new ArrayBuffer(44 + sampleCount * 2)
  const view = new DataView(wav)
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + sampleCount * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, METRONOME_SAMPLE_RATE, true)
  view.setUint32(28, METRONOME_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  const frequency = accent ? definition.high : definition.low
  for (let index = 0; index < sampleCount; index++) {
    const progress = index / sampleCount
    const envelope = Math.pow(1 - progress, accent ? 3.5 : 4.5)
    const phase = 2 * Math.PI * frequency * index / METRONOME_SAMPLE_RATE
    const oscillator = definition.type === 'square'
      ? (Math.sin(phase) >= 0 ? 1 : -1)
      : definition.type === 'triangle'
        ? 2 / Math.PI * Math.asin(Math.sin(phase))
        : Math.sin(phase)
    view.setInt16(44 + index * 2, Math.round(oscillator * envelope * 0.65 * 32767), true)
  }
  return wav
}

function writeLocalAudioFile(filePath: string, data: ArrayBuffer) {
  return new Promise<void>((resolve, reject) => {
    const fileSystem = (wx as any).getFileSystemManager && (wx as any).getFileSystemManager()
    if (!fileSystem) {
      reject(new Error('当前环境不支持本地音频文件'))
      return
    }
    fileSystem.writeFile({ filePath, data, success: resolve, fail: reject })
  })
}

function prepareMetronomeClickFiles() {
  if (metronomeClickPaths) return Promise.resolve(metronomeClickPaths)
  if (metronomeClickPreparation) return metronomeClickPreparation
  const wxAudio = wx as any
  const userDataPath = wxAudio.env && wxAudio.env.USER_DATA_PATH
  if (!userDataPath) return Promise.reject(new Error('当前环境不支持本地音频缓存'))
  const entries = Object.keys(METRONOME_TONE_CONFIG).flatMap((tone) => [true, false].flatMap((accent) => [
    { profile: 'full', durationMs: METRONOME_CLICK_FULL_DURATION_MS },
    { profile: 'short', durationMs: METRONOME_CLICK_SHORT_DURATION_MS },
  ].map(({ profile, durationMs }) => ({
    key: `${tone}-${accent ? 'accent' : 'regular'}-${profile}`,
    filePath: `${userDataPath}/leta-metronome-v3-${tone}-${accent ? 'accent' : 'regular'}-${profile}.wav`,
    data: createMetronomeClickWav(tone, accent, durationMs),
  }))))
  metronomeClickPreparation = Promise.all(entries.map((entry) => writeLocalAudioFile(entry.filePath, entry.data)))
    .then(() => {
      metronomeClickPaths = entries.reduce((paths, entry) => ({ ...paths, [entry.key]: entry.filePath }), {})
      return metronomeClickPaths
    })
    .catch((error) => {
      metronomeClickPreparation = null
      throw error
    })
  return metronomeClickPreparation
}

function configureInnerAudio() {
  if (innerAudioConfigured) return
  innerAudioConfigured = true
  const wxAudio = wx as any
  if (typeof wxAudio.setInnerAudioOption !== 'function') return
  wxAudio.setInnerAudioOption({
    obeyMuteSwitch: false,
    mixWithOther: true,
    fail: (error: any) => console.info('当前环境不支持节拍器音频输出配置', error),
  })
}

Component({
  data: {
    activeTab: 'sing' as TabKey,
    instrumentView: 'home' as 'home' | 'metronome',
    tabs: [
      { key: 'sing', label: '唱', icon: '/assets/tabbar/sing.png' },
      { key: 'instrument', label: '乐器', icon: '/assets/tabbar/instrument.png' },
      { key: 'theory', label: '乐理', icon: '/assets/tabbar/theory.png' },
      { key: 'practice', label: '练习', icon: '/assets/tabbar/practice.png' },
      { key: 'me', label: '我的', icon: '/assets/tabbar/me.png' },
    ],
    beatOptions: [1, 2, 3, 4],
    timeSignatures: [
      { label: '2/4', beats: 2 },
      { label: '3/4', beats: 3 },
      { label: '4/4', beats: 4 },
      { label: '6/8', beats: 6 },
    ],
    rhythmOptions: [
      { key: 'off', symbol: 'OFF', ariaLabel: '关闭节奏细分' },
      { key: 'eighth', symbol: '♪', ariaLabel: '八分音符细分' },
      { key: 'triplet', symbol: '♩³', ariaLabel: '三连音细分' },
      { key: 'sixteenth', symbol: '♬', ariaLabel: '十六分音符细分' },
    ],
    toneOptions: [
      { key: 'classic', label: '清脆' },
      { key: 'wood', label: '木质' },
      { key: 'soft', label: '柔和' },
    ],
    theoryProgress: 2,
    metronomePlaying: false,
    metronomeStarting: false,
    countInActive: false,
    countInEnabled: true,
    countInCountdown: 0,
    bpm: 80,
    beat: 0,
    beatsPerMeasure: 4,
    timeSignature: '4/4',
    metronomeRhythm: 'off',
    metronomeTone: 'classic',
    metronomeVolume: 70,
    pendulumDuration: 750,
    metronomeRecordPreparing: false,
    metronomeRecording: false,
    metronomeRecordStarting: false,
    metronomeHasRecording: false,
    metronomeRecordingSeconds: 0,
    metronomePlayback: false,
    metronomePlaybackSeconds: 0,
    metronomePlaybackDuration: 0,
    metronomePlaybackProgress: 0,
    practiceMinutes: 0,
    practiceDays: 0,
    feedbackMode: '温和',
  },
  lifetimes: {
    attached() {
      this.loadStats()
      this.attachRecorderSession()
      const app = getApp<IAppOption>() as any
      if (app.globalData.openMetronomeRoute) {
        app.globalData.openMetronomeRoute = false
        this.setData({ activeTab: 'instrument', instrumentView: 'metronome' })
        wx.setNavigationBarTitle({ title: '节拍器' })
      }
    },
    detached() {
      this.stopMetronome()
      this.stopMetronomeRecording(true)
      this.stopMetronomeRecordingPlayback(false)
      if (recorderSession) recorderSession.detach(this)
      if (metronomeContext && metronomeContext.close) metronomeContext.close()
      metronomeContext = null
    },
  },
  pageLifetimes: {
    show() { this.loadStats(); this.attachRecorderSession() },
    hide() {
      this.stopMetronome()
      this.stopMetronomeRecording(true)
      this.stopMetronomeRecordingPlayback(false)
      if (recorderSession) recorderSession.detach(this)
    },
  },
  methods: {
    attachRecorderSession() {
      if (!recorderSession) recorderSession = createRecorderSession(wx.getRecorderManager())
      metronomeRecordingState.recorder = recorderSession.attach(this)
    },
    loadStats() {
      const stats = wx.getStorageSync('leta-stats') || {}
      const feedbackMode = wx.getStorageSync('leta-feedback-mode') || '温和'
      const storedTheoryProgress = Number(stats.theoryProgress)
      const theoryProgress = Number.isFinite(storedTheoryProgress)
        ? Math.max(0, Math.min(8, Math.round(storedTheoryProgress)))
        : 2
      this.setData({ practiceMinutes: stats.practiceMinutes || 0, practiceDays: stats.practiceDays || 0, theoryProgress, feedbackMode })
    },
    switchTab(e: any) {
      const key = e.currentTarget.dataset.key as TabKey
      if (key === 'theory' || key === 'practice' || key === 'me') {
        wx.showToast({ title: key === 'theory' ? '开放中' : '开发中', icon: 'none' })
        return
      }
      if (key !== 'instrument' || this.data.instrumentView === 'metronome') this.stopMetronome()
      this.setData({ activeTab: key, instrumentView: key === 'instrument' ? 'home' : this.data.instrumentView })
    },
    startSinging() { this.stopMetronome(); wx.navigateTo({ url: '../singing/index?mode=scale' }) },
    startSingle() { this.stopMetronome(); wx.navigateTo({ url: '../singing/index?mode=single' }) },
    startEarTraining() { this.stopMetronome(); wx.navigateTo({ url: '../ear-training/index' }) },
    openMetronome() {
      const app = getApp<IAppOption>() as any
      app.globalData.openMetronomeRoute = true
      wx.navigateTo({
        url: '/pages/index/index',
        fail: (error) => {
          app.globalData.openMetronomeRoute = false
          console.error('打开节拍器页面失败', error)
          wx.showToast({ title: '打开节拍器失败，请重试', icon: 'none' })
        },
      })
    },
    backToInstrumentHome() {
      this.stopMetronome()
      const pages = getCurrentPages()
      if (pages.length > 1) {
        wx.navigateBack()
        return
      }
      wx.setNavigationBarTitle({ title: '乐搭' })
      this.setData({ instrumentView: 'home' })
    },
    openTheory() { this.setData({ activeTab: 'theory' }) },
    toggleMetronome() { this.data.metronomePlaying || this.data.countInActive || this.data.metronomeStarting ? this.stopMetronome() : this.startMetronome() },
    startMetronome() {
      this.stopMetronome(true)
      this.startMetronomeAfterAudioReady(this.data.countInEnabled)
    },
    startMetronomeAfterAudioReady(includeCountIn: boolean) {
      const token = ++metronomeStartToken
      const wxAudio = wx as any
      let createdContext: any = null
      this.setData({ metronomeStarting: true })
      configureInnerAudio()
      prepareMetronomeClickFiles()
        .then((context: any) => {
          if (token !== metronomeStartToken) {
            return
          }
          metronomeClickPaths = context
          metronomeSoundMode = 'file'
          this.setData({ metronomeStarting: false })
          if (includeCountIn) this.startCountIn()
          else this.beginMetronome()
        })
        .catch((error: any) => {
          console.error('准备节拍器本地音频失败，尝试 WebAudio 降级', error)
          prepareAudioContext(metronomeContext, () => {
            createdContext = typeof wxAudio.createWebAudioContext === 'function' ? wxAudio.createWebAudioContext() : null
            return createdContext
          })
            .then((context: any) => {
              if (token !== metronomeStartToken) {
                if (createdContext === context && context.close) context.close()
                return
              }
              metronomeContext = context
              metronomeSoundMode = 'webaudio'
              this.setData({ metronomeStarting: false })
              if (includeCountIn) this.startCountIn()
              else this.beginMetronome()
            })
            .catch((fallbackError: any) => {
              if (createdContext && createdContext.close) createdContext.close()
              if (token !== metronomeStartToken) return
              console.error('节拍器音频启动失败', fallbackError)
              metronomeContext = null
              metronomeSoundMode = null
              this.setData({ metronomeStarting: false, metronomePlaying: false, countInActive: false })
              wx.showToast({ title: '节拍器声音启动失败，请重试', icon: 'none' })
            })
        })
    },
    startCountIn() {
      let remaining = this.data.beatsPerMeasure
      const interval = 60000 / this.data.bpm
      this.setData({ countInActive: true, countInCountdown: remaining, metronomePlaying: false, beat: 0 })
      this.playMetronomeTone(true, true)
      countInTimer = setInterval(() => {
        remaining--
        if (remaining <= 0) {
          if (countInTimer) clearInterval(countInTimer)
          countInTimer = null
          this.beginMetronome()
          return
        }
        this.setData({ countInCountdown: remaining })
        this.playMetronomeTone(false, true)
      }, interval)
    },
    beginMetronome() {
      this.setData({ countInActive: false, countInCountdown: 0, metronomePlaying: true, beat: 0 })
      this.runMetronomeTick(Date.now())
    },
    runMetronomeTick(scheduledAt: number) {
      if (!this.data.metronomePlaying) return
      this.tickMetronome()
      const interval = 60000 / this.data.bpm
      const now = Date.now()
      const nextScheduledAt = scheduledAt + interval > now ? scheduledAt + interval : now + interval
      metronomeTimer = setTimeout(() => this.runMetronomeTick(nextScheduledAt), Math.max(0, nextScheduledAt - Date.now()))
    },
    stopMetronome(keepRecording = false) {
      metronomeStartToken++
      if (metronomeTimer) clearTimeout(metronomeTimer)
      if (countInTimer) clearInterval(countInTimer)
      this.clearRhythmTimers()
      metronomeTimer = null
      countInTimer = null
      this.setData({ metronomePlaying: false, metronomeStarting: false, countInActive: false, countInCountdown: 0, beat: 0 })
      if (!keepRecording) this.stopMetronomeRecording(false)
    },
    restartMetronomeWithoutCountIn() {
      const shouldRestart = this.data.metronomePlaying || this.data.countInActive || this.data.metronomeStarting
      this.stopMetronome()
      if (shouldRestart) this.startMetronomeAfterAudioReady(false)
    },
    tickMetronome() {
      const beat = this.data.beat % this.data.beatsPerMeasure + 1
      this.setData({ beat })
      if (beat === 1) wx.vibrateShort({ type: 'light' })
      this.playMetronomeTone(beat === 1)
      this.scheduleRhythmSubdivisions()
    },
    clearRhythmTimers() {
      rhythmTimers.forEach((timer) => clearTimeout(timer))
      rhythmTimers = []
    },
    scheduleRhythmSubdivisions() {
      this.clearRhythmTimers()
      const subdivisions = RHYTHM_SUBDIVISIONS[this.data.metronomeRhythm] || 1
      if (subdivisions < 2 || !this.data.metronomePlaying) return
      const beatDuration = 60000 / this.data.bpm
      const playbackToken = metronomeStartToken
      for (let index = 1; index < subdivisions; index++) {
        const timer = setTimeout(() => {
          if (playbackToken === metronomeStartToken && this.data.metronomePlaying) this.playMetronomeTone(false)
        }, Math.round(beatDuration * index / subdivisions))
        rhythmTimers.push(timer)
      }
    },
    playMetronomeTone(accent: boolean, countIn = false) {
      if (metronomeSoundMode === 'file') {
        const subdivisions = RHYTHM_SUBDIVISIONS[this.data.metronomeRhythm] || 1
        const subdivisionDuration = 60000 / this.data.bpm / subdivisions
        const profile = subdivisionDuration < 92 ? 'short' : 'full'
        const key = `${this.data.metronomeTone}-${accent ? 'accent' : 'regular'}-${profile}`
        const source = metronomeClickPaths && metronomeClickPaths[key]
        if (!source) {
          console.error('未找到节拍器本地音频', { key })
          return
        }
        const player = wx.createInnerAudioContext()
        let started = false
        const startPlayback = () => {
          if (started) return
          started = true
          player.play()
        }
        player.autoplay = false
        player.obeyMuteSwitch = false
        player.volume = Math.max(0, Math.min(1, this.data.metronomeVolume / 100)) * (countIn ? 0.82 : 1)
        player.onCanplay(startPlayback)
        player.onError((error) => {
          console.error('播放节拍器本地音频失败', error)
          player.destroy()
        })
        player.onEnded(() => player.destroy())
        player.src = source
        return
      }
      if (metronomeSoundMode !== 'webaudio' || !metronomeContext) return
      try {
        const toneMap: Record<string, { type: string; high: number; low: number; duration: number; level: number }> = {
          classic: { type: 'sine', high: 1120, low: 760, duration: 0.055, level: 1 },
          wood: { type: 'square', high: 880, low: 620, duration: 0.035, level: 0.55 },
          soft: { type: 'triangle', high: 720, low: 520, duration: 0.09, level: 0.72 },
        }
        const tone = toneMap[this.data.metronomeTone] || toneMap.classic
        const now = metronomeContext.currentTime
        const subdivisions = RHYTHM_SUBDIVISIONS[this.data.metronomeRhythm] || 1
        const maxDuration = 60000 / this.data.bpm / subdivisions * 0.65 / 1000
        const duration = Math.min(tone.duration, maxDuration)
        const oscillator = metronomeContext.createOscillator()
        const gain = metronomeContext.createGain()
        oscillator.type = tone.type
        oscillator.frequency.value = accent ? tone.high : tone.low
        const volume = Math.max(0, Math.min(1, this.data.metronomeVolume / 100))
        const baseLevel = accent ? 0.24 : 0.13
        gain.gain.setValueAtTime(Math.max(0.0001, baseLevel * tone.level * volume * (countIn ? 0.82 : 1)), now)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
        oscillator.connect(gain)
        gain.connect(metronomeContext.destination)
        oscillator.start(now)
        oscillator.stop(now + duration + 0.01)
      } catch (error) {
        console.error('节拍器发声失败', error)
        if (metronomeContext && metronomeContext.close) {
          const closeResult = metronomeContext.close()
          if (closeResult && typeof closeResult.catch === 'function') closeResult.catch((closeError: any) => console.error('关闭异常音频上下文失败', closeError))
        }
        metronomeContext = null
        this.stopMetronome()
        wx.showToast({ title: '节拍器声音启动失败', icon: 'none' })
      }
    },
    changeBpmFromSlider(e: any) {
      const bpm = normalizeBpm(e.detail.value)
      this.setData({ bpm, pendulumDuration: Math.round(60000 / bpm) })
    },
    commitBpm(e: any) {
      const bpm = normalizeBpm(e && e.detail ? e.detail.value : this.data.bpm)
      this.setData({ bpm, pendulumDuration: Math.round(60000 / bpm) }, () => this.restartMetronomeWithoutCountIn())
    },
    selectTimeSignature(e: any) {
      const beats = Number(e.currentTarget.dataset.beats)
      const label = String(e.currentTarget.dataset.label)
      if (!Number.isFinite(beats) || beats < 1) return
      this.setData({ timeSignature: label, beatsPerMeasure: beats, beatOptions: Array.from({ length: beats }, (_, index) => index + 1) })
      this.restartMetronomeWithoutCountIn()
    },
    selectRhythm(e: any) {
      const rhythm = String(e.currentTarget.dataset.rhythm)
      if (!Object.prototype.hasOwnProperty.call(RHYTHM_SUBDIVISIONS, rhythm)) return
      this.setData({ metronomeRhythm: rhythm })
      this.restartMetronomeWithoutCountIn()
    },
    selectTone(e: any) { this.setData({ metronomeTone: String(e.currentTarget.dataset.tone) }) },
    changeVolume(e: any) { this.setData({ metronomeVolume: Number(e.detail.value) }) },
    toggleCountIn() {
      const enabled = !this.data.countInEnabled
      this.setData({ countInEnabled: enabled })
      if (!enabled && this.data.countInActive) {
        if (countInTimer) clearInterval(countInTimer)
        countInTimer = null
        this.beginMetronome()
      }
      wx.showToast({ title: enabled ? '已开启预备拍' : '已关闭预备拍', icon: 'none' })
    },
    toggleMetronomeRecording() {
      if (this.data.metronomeRecordPreparing) {
        metronomeRecordingState.requestId++
        this.setData({ metronomeRecordPreparing: false })
        return
      }
      if (this.data.metronomeRecording || this.data.metronomeRecordStarting) {
        this.stopMetronomeRecording(false)
        return
      }
      this.requestMetronomeRecordPermission()
    },
    requestMetronomeRecordPermission() {
      const requestId = ++metronomeRecordingState.requestId
      this.setData({ metronomeRecordPreparing: true })
      wx.getSetting({
        success: (settings) => {
          if (requestId !== metronomeRecordingState.requestId) return
          if (settings.authSetting['scope.record'] === true) {
            this.beginMetronomeRecording()
            return
          }
          if (settings.authSetting['scope.record'] === false) {
            this.handleMetronomeRecordPermissionDenied()
            return
          }
          wx.authorize({
            scope: 'scope.record',
            success: () => { if (requestId === metronomeRecordingState.requestId) this.beginMetronomeRecording() },
            fail: () => { if (requestId === metronomeRecordingState.requestId) this.handleMetronomeRecordPermissionDenied() },
          })
        },
        fail: (error) => {
          console.error('读取节拍器麦克风权限失败', error)
          if (requestId === metronomeRecordingState.requestId) this.handleMetronomeRecordPermissionDenied()
        },
      })
    },
    handleMetronomeRecordPermissionDenied() {
      this.setData({ metronomeRecordPreparing: false })
      wx.showModal({
        title: '需要麦克风权限',
        content: '允许使用麦克风后，才能录下你跟节拍练习的声音。',
        confirmText: '去设置',
        success: (result) => {
          if (!result.confirm) return
          wx.openSetting({ fail: (error) => console.error('打开节拍器麦克风设置失败', error) })
        },
      })
    },
    beginMetronomeRecording() {
      this.stopMetronomeRecordingPlayback(false)
      this.attachRecorderSession()
      if (!recorderSession || !metronomeRecordingState.recorder) {
        console.error('节拍器录音管理器不可用')
        this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: false, metronomeRecording: false })
        wx.showToast({ title: '录音暂不可用，请重试', icon: 'none' })
        return
      }
      metronomeRecordingState.requested = true
      metronomeRecordingState.discarded = false
      metronomeRecordingState.starting = true
      metronomeRecordingState.path = ''
      this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: true, metronomeRecording: false, metronomeHasRecording: false, metronomeRecordingSeconds: 0, metronomePlaybackSeconds: 0, metronomePlaybackDuration: 0, metronomePlaybackProgress: 0 })
      if (recorderSession.isBusy()) {
        const requestId = metronomeRecordingState.requestId
        wx.showToast({ title: '正在结束上一段录音…', icon: 'none' })
        recorderSession.whenIdle(() => {
          if (!metronomeRecordingState.requested || requestId !== metronomeRecordingState.requestId) return
          setTimeout(() => this.beginMetronomeRecording(), 120)
        })
        return
      }
      try {
        const started = recorderSession.start(this, { duration: METRONOME_RECORD_MAX_DURATION_MS, sampleRate: 44100, encodeBitRate: 96000, numberOfChannels: 1, format: 'mp3' })
        if (!started) {
          recorderSession.whenIdle(() => {
            if (metronomeRecordingState.requested) setTimeout(() => this.beginMetronomeRecording(), 120)
          })
        }
      } catch (error) {
        metronomeRecordingState.requested = false
        metronomeRecordingState.starting = false
        console.error('启动节拍器录音失败', error)
        this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: false, metronomeRecording: false })
        wx.showToast({ title: '录音启动失败，请重试', icon: 'none' })
      }
    },
    handleRecorderStarted() {
      metronomeRecordingState.starting = false
      if (!metronomeRecordingState.requested) {
        try { metronomeRecordingState.recorder.stop() } catch (error) { console.error('停止过期节拍器录音失败', error) }
        return
      }
      metronomeRecordingState.active = true
      metronomeRecordingState.startedAt = Date.now()
      this.startMetronomeRecordingTimer()
      this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: false, metronomeRecording: true })
      if (!this.data.metronomePlaying && !this.data.countInActive && !this.data.metronomeStarting) this.startMetronome()
    },
    handleRecorderStop(result: any) {
      const discarded = metronomeRecordingState.discarded
      const recordedSeconds = Math.max(this.data.metronomeRecordingSeconds, Math.ceil(Number(result && result.duration) / 1000) || 0)
      metronomeRecordingState.requested = false
      metronomeRecordingState.active = false
      metronomeRecordingState.starting = false
      this.stopMetronomeRecordingTimer()
      if (discarded) {
        this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: false, metronomeRecording: false })
        return
      }
      if (!result || !result.tempFilePath) {
        console.error('节拍器录音结束后未返回临时文件路径', result)
        this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: false, metronomeRecording: false })
        wx.showToast({ title: '录音保存失败，请重试', icon: 'none' })
        return
      }
      metronomeRecordingState.path = result.tempFilePath
      this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: false, metronomeRecording: false, metronomeHasRecording: true, metronomeRecordingSeconds: recordedSeconds, metronomePlaybackDuration: recordedSeconds, metronomePlaybackSeconds: 0, metronomePlaybackProgress: 0 })
      wx.showToast({ title: `已保存 ${recordedSeconds} 秒录音`, icon: 'success' })
    },
    handleRecorderError(error: any) {
      metronomeRecordingState.requested = false
      metronomeRecordingState.active = false
      metronomeRecordingState.starting = false
      this.stopMetronomeRecordingTimer()
      console.error('节拍器录音失败', error)
      this.setData({ metronomeRecordPreparing: false, metronomeRecordStarting: false, metronomeRecording: false })
      wx.showToast({ title: '录音失败，请检查麦克风权限', icon: 'none' })
    },
    handleAudioFrame() {},
    stopMetronomeRecording(discard: boolean) {
      if (!metronomeRecordingState.requested && !metronomeRecordingState.active && !metronomeRecordingState.starting) return
      metronomeRecordingState.requested = false
      metronomeRecordingState.discarded = metronomeRecordingState.discarded || discard
      this.stopMetronomeRecordingTimer()
      if (!metronomeRecordingState.active && !metronomeRecordingState.starting) return
      try { metronomeRecordingState.recorder.stop() } catch (error) { console.error('停止节拍器录音失败', error) }
    },
    startMetronomeRecordingTimer() {
      this.stopMetronomeRecordingTimer()
      metronomeRecordingState.timer = setInterval(() => {
        const seconds = Math.min(Math.ceil((Date.now() - metronomeRecordingState.startedAt) / 1000), Math.ceil(METRONOME_RECORD_MAX_DURATION_MS / 1000))
        this.setData({ metronomeRecordingSeconds: seconds })
      }, 500) as any
    },
    stopMetronomeRecordingTimer() {
      if (metronomeRecordingState.timer) clearInterval(metronomeRecordingState.timer)
      metronomeRecordingState.timer = 0
    },
    toggleMetronomeRecordingPlayback() {
      if (this.data.metronomePlayback) {
        this.stopMetronomeRecordingPlayback(true)
        return
      }
      if (!this.data.metronomeHasRecording || !metronomeRecordingState.path) {
        wx.showToast({ title: '先录一段节拍练习', icon: 'none' })
        return
      }
      this.stopMetronome()
      this.destroyMetronomeRecordingPlayer()
      const player = wx.createInnerAudioContext()
      metronomeRecordingState.player = player
      player.autoplay = false
      player.obeyMuteSwitch = false
      player.onPlay(() => { if (metronomeRecordingState.player === player) this.setData({ metronomePlayback: true }) })
      player.onTimeUpdate(() => {
        if (metronomeRecordingState.player !== player) return
        const duration = Math.max(0.001, player.duration || this.data.metronomePlaybackDuration)
        const current = Math.min(duration, player.currentTime || 0)
        this.setData({ metronomePlaybackSeconds: Math.floor(current), metronomePlaybackProgress: Math.min(100, current / duration * 100) })
      })
      player.onEnded(() => {
        if (metronomeRecordingState.player !== player) return
        const duration = this.data.metronomePlaybackDuration
        this.destroyMetronomeRecordingPlayer()
        this.setData({ metronomePlayback: false, metronomePlaybackSeconds: duration, metronomePlaybackProgress: 100 })
      })
      player.onError((error) => {
        if (metronomeRecordingState.player !== player) return
        console.error('播放节拍器录音失败', error)
        this.destroyMetronomeRecordingPlayer()
        this.setData({ metronomePlayback: false })
        wx.showToast({ title: '录音回放失败，请重新录制', icon: 'none' })
      })
      player.src = metronomeRecordingState.path
      player.play()
    },
    stopMetronomeRecordingPlayback(showToast: boolean) {
      const wasPlaying = this.data.metronomePlayback
      this.destroyMetronomeRecordingPlayer()
      if (!wasPlaying) return
      this.setData({ metronomePlayback: false })
      if (showToast) wx.showToast({ title: '已停止回放', icon: 'none' })
    },
    destroyMetronomeRecordingPlayer() {
      const player = metronomeRecordingState.player
      metronomeRecordingState.player = null
      if (!player) return
      try {
        player.stop()
        player.destroy()
      } catch (error) {
        console.error('关闭节拍器录音播放器失败', error)
      }
    },
    continueLesson() { this.stopMetronome(); wx.navigateTo({ url: '../theory/index' }) },
    showComingSoon() { wx.showToast({ title: '这个练习正在准备中', icon: 'none' }) },
    showSetting(e: any) {
      const key = e.currentTarget.dataset.key
      if (key === 'feedback') {
        const next = this.data.feedbackMode === '温和' ? '直接' : this.data.feedbackMode === '直接' ? '少提示' : '温和'
        wx.setStorageSync('leta-feedback-mode', next)
        this.setData({ feedbackMode: next })
        wx.showToast({ title: `反馈：${next}`, icon: 'none' })
        return
      }
      if (key === 'audio') {
        wx.openSetting({ fail: (error) => { console.error('打开音频权限设置失败', error); wx.showToast({ title: '请在系统设置中检查麦克风权限', icon: 'none' }) } })
        return
      }
      wx.showModal({ title: '关于乐搭', content: '乐搭是陪音乐新手慢慢练基本功的小搭子。当前版本 0.1。\n\n导航图标来自 Flaticon，完整署名见项目素材说明。', showCancel: false, confirmText: '知道了' })
    },
  },
})
